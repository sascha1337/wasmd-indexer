import * as Sentry from '@sentry/node'
import { Sequelize } from 'sequelize'

import {
  ParsedWasmEvent,
  base64KeyToEventKey,
  objectMatchesStructure,
} from '@/core'
import {
  AccountWebhook,
  Contract,
  PendingWebhook,
  State,
  WasmEvent,
  WasmEventTransformation,
  updateComputationValidityDependentOnChanges,
} from '@/db'
import { updateIndexesForContracts } from '@/ms'

import { ModuleExporter, ModuleExporterMaker } from '../types'

type IndexerWasmEvent = {
  blockHeight: number
  blockTimeUnixMs: number
  contractAddress: string
  codeId: number
  key: string
  value: string
  delete: boolean
}

export const wasm: ModuleExporterMaker = ({
  config,
  state,
  initialBlockHeight,
  batch,
  updateComputations,
  sendWebhooks,
}) => {
  const pending: IndexerWasmEvent[] = []

  const initialBlock =
    initialBlockHeight ??
    // Start at the next block after the last exported block if no initial block
    // set.
    BigInt(state.lastWasmBlockHeightExported ?? '0') + 1n

  let lastBlockHeightSeen = 0
  let catchingUp = true

  const flush = async () => {
    if (pending.length === 0) {
      return
    }

    // For events with the same blockHeight, contractAddress, and key, only
    // keep the last event. This is because the indexer guarantees that events
    // are emitted in order, and the last event is the most up-to-date.
    // Multiple events may occur if the value is updated multiple times across
    // different messages. The indexer can only maintain uniqueness within a
    // message and its submessages, but different messages in the same block
    // can write to the same key, and the indexer emits all the messages.
    const uniqueIndexerEvents = pending.reduce((acc, event) => {
      const key = event.blockHeight + event.contractAddress + event.key
      acc[key] = event
      return acc
    }, {} as Record<string, IndexerWasmEvent>)
    const eventsToExport = Object.values(uniqueIndexerEvents)

    const parsedEvents = eventsToExport.map((event): ParsedWasmEvent => {
      // Convert base64 value to utf-8 string, if present.
      const value =
        event.value && Buffer.from(event.value, 'base64').toString('utf-8')

      let valueJson = null
      if (!event.delete && value) {
        try {
          valueJson = JSON.parse(value ?? 'null')
        } catch {
          // Ignore parsing errors.
        }
      }

      const blockTimestamp = new Date(event.blockTimeUnixMs)

      return {
        codeId: event.codeId,
        contractAddress: event.contractAddress,
        blockHeight: event.blockHeight.toString(),
        blockTimeUnixMs: event.blockTimeUnixMs.toString(),
        blockTimestamp,
        // Convert base64 key to comma-separated list of bytes. See
        // explanation in `Event` model for more information.
        key: base64KeyToEventKey(event.key),
        value,
        valueJson,
        delete: event.delete,
      }
    })

    // Export events.
    const {
      computationsUpdated,
      computationsDestroyed,
      transformations,
      webhooksQueued,
      lastBlockHeightExported,
    } = await exporter(parsedEvents, !updateComputations, !sendWebhooks)

    // Log.
    console.log(
      `[wasm] Exported: ${parsedEvents.length.toLocaleString()}. Latest block exported: ${lastBlockHeightExported.toLocaleString()}. Transformed: ${transformations.toLocaleString()}. Webhooks queued: ${webhooksQueued.toLocaleString()}. Computations updated/destroyed: ${computationsUpdated.toLocaleString()}/${computationsDestroyed.toLocaleString()}.`
    )

    // Clear queue.
    pending.length = 0
  }

  const handler: ModuleExporter['handler'] = async (line) => {
    let event: IndexerWasmEvent
    try {
      event = JSON.parse(line)

      // If event not of expected structure, skip.
      if (
        !objectMatchesStructure(event, {
          blockHeight: {},
          blockTimeUnixMs: {},
          contractAddress: {},
          codeId: {},
          key: {},
          value: {},
          delete: {},
        })
      ) {
        throw new Error('Invalid line structure.')
      }
    } catch (err) {
      // Capture error so we can investigate.
      Sentry.captureException(err, {
        tags: {
          module: 'staking',
        },
        extra: {
          line,
        },
      })

      // If event not valid JSON, skip.
      return
    }

    // If event is from a block before the initial block, skip.
    if (BigInt(event.blockHeight) < initialBlock) {
      lastBlockHeightSeen = event.blockHeight
      return
    } else if (catchingUp) {
      console.log(
        `[wasm] Caught up to initial block ${initialBlock.toLocaleString()}.`
      )
      catchingUp = false
    }

    // If we have enough events and reached the first event of the next block,
    // flush the previous events to the DB. This ensures we batch all events
    // from the same block together.
    if (pending.length >= batch && event.blockHeight > lastBlockHeightSeen) {
      await flush()
    }

    pending.push(event)
    lastBlockHeightSeen = event.blockHeight
  }

  return {
    sourceFile: config.sources.wasm,
    handler,
    flush,
  }
}

// TODO: Create pipeline architecture, handle errors better, etc.
const exporter = async (
  parsedEvents: ParsedWasmEvent[],
  dontUpdateComputations = false,
  dontSendWebhooks = false
): Promise<{
  computationsUpdated: number
  computationsDestroyed: number
  transformations: number
  webhooksQueued: number
  lastBlockHeightExported: bigint
}> => {
  const state = await State.getSingleton()
  if (!state) {
    throw new Error('State not found while exporting')
  }

  const uniqueContracts = [
    ...new Set(parsedEvents.map((event) => event.contractAddress)),
  ]

  // Try to create contracts up to 3 times. This has previously failed due to a
  // deadlock.
  let contractCreationAttempts = 3
  while (contractCreationAttempts > 0) {
    try {
      // Ensure contract exists before creating events. `address` is unique.
      await Contract.bulkCreate(
        uniqueContracts.map((address) => {
          const event = parsedEvents.find(
            (event) => event.contractAddress === address
          )
          // Should never happen since `uniqueContracts` is derived from
          // `parsedEvents`.
          if (!event) {
            throw new Error('Event not found when creating contract.')
          }

          return {
            address,
            codeId: event.codeId,
            // Set the contract instantiation block to the first event found in
            // the list of parsed events. Events are sorted in ascending order
            // by creation block. These won't get updated if the contract
            // already exists, so it's safe to always attempt creation with the
            // first event's block. Only `codeId` gets updated below when a
            // duplicate is found.
            instantiatedAtBlockHeight: event.blockHeight,
            instantiatedAtBlockTimeUnixMs: event.blockTimeUnixMs,
            instantiatedAtBlockTimestamp: event.blockTimestamp,
          }
        }),
        // When contract is migrated, codeId changes.
        {
          updateOnDuplicate: ['codeId'],
        }
      )

      // Break on success.
      break
    } catch (err) {
      console.error('wasm', err)
      Sentry.captureException(err, {
        tags: {
          script: 'export',
          module: 'wasm',
        },
        extra: {
          uniqueContracts,
        },
      })
      contractCreationAttempts--

      // If we've tried all times, throw the error so we halt.
      if (contractCreationAttempts === 0) {
        throw err
      }
    }
  }

  // Get updated contracts.
  const contracts = await Contract.findAll({
    where: {
      address: uniqueContracts,
    },
  })

  // Unique index on [blockHeight, contractAddress, key] ensures that we don't
  // insert duplicate events. If we encounter a duplicate, we update the
  // `value`, `valueJson`, and `delete` fields in case event processing for a
  // block was batched separately.
  const exportedEvents = await WasmEvent.bulkCreate(parsedEvents, {
    updateOnDuplicate: ['value', 'valueJson', 'delete'],
  })
  // Add contracts to events since webhooks need to access contract code IDs.
  exportedEvents.forEach((event) => {
    event.contract = contracts.find(
      (contract) => contract.address === event.contractAddress
    )!
  })

  // Transform events as needed.
  const transformations = await WasmEventTransformation.transformParsedEvents(
    parsedEvents
  )

  let computationsUpdated = 0
  let computationsDestroyed = 0
  if (!dontUpdateComputations) {
    const computationUpdates =
      await updateComputationValidityDependentOnChanges([
        ...exportedEvents,
        ...transformations,
      ])
    computationsUpdated = computationUpdates.updated
    computationsDestroyed = computationUpdates.destroyed
  }

  // Queue webhooks as needed.
  const webhooksQueued = dontSendWebhooks
    ? 0
    : (await PendingWebhook.queueWebhooks(state, exportedEvents)) +
      (await AccountWebhook.queueWebhooks(exportedEvents))

  // Store last block height exported, and update latest block height/time if
  // the last export is newer.
  const lastBlockHeightExported =
    parsedEvents[parsedEvents.length - 1].blockHeight
  const lastBlockTimeUnixMsExported =
    parsedEvents[parsedEvents.length - 1].blockTimeUnixMs
  await State.update(
    {
      lastWasmBlockHeightExported: Sequelize.fn(
        'GREATEST',
        Sequelize.col('lastWasmBlockHeightExported'),
        lastBlockHeightExported
      ),

      latestBlockHeight: Sequelize.fn(
        'GREATEST',
        Sequelize.col('latestBlockHeight'),
        lastBlockHeightExported
      ),
      latestBlockTimeUnixMs: Sequelize.fn(
        'GREATEST',
        Sequelize.col('latestBlockTimeUnixMs'),
        lastBlockTimeUnixMsExported
      ),
    },
    {
      where: {
        singleton: true,
      },
    }
  )

  // Update meilisearch indexes. This must happen after the state is updated
  // since it uses the latest block.
  await updateIndexesForContracts(contracts)

  return {
    computationsUpdated,
    computationsDestroyed,
    transformations: transformations.length,
    lastBlockHeightExported: BigInt(lastBlockHeightExported),
    webhooksQueued,
  }
}
