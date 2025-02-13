import axios from 'axios'
import Pusher from 'pusher'
import {
  AllowNull,
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from 'sequelize-typescript'

import {
  ContractEnv,
  WebhookEndpoint,
  WebhookType,
  getEnv,
  loadConfig,
} from '@/core'
import { getProcessedWebhooks } from '@/data/webhooks'

import { State } from './State'
import { WasmEvent } from './WasmEvent'

@Table({
  timestamps: true,
})
export class PendingWebhook extends Model {
  @AllowNull(false)
  @ForeignKey(() => WasmEvent)
  @Column
  eventId!: number

  @BelongsTo(() => WasmEvent)
  event!: WasmEvent

  @AllowNull(false)
  @Column(DataType.JSONB)
  endpoint!: WebhookEndpoint

  @AllowNull(false)
  @Column(DataType.JSONB)
  value!: any

  @AllowNull(false)
  @Column(DataType.INTEGER)
  failures!: number

  async fire() {
    try {
      switch (this.endpoint.type) {
        case WebhookType.Url:
          await axios(this.endpoint.url, {
            method: this.endpoint.method,
            // https://stackoverflow.com/a/74735197
            headers: {
              'Accept-Encoding': 'gzip,deflate,compress',
              ...this.endpoint.headers,
            },
            data: this.value,
          })

          break

        case WebhookType.Soketi:
          const { soketi } = loadConfig()
          if (!soketi) {
            throw new Error('Soketi config not found')
          }

          const pusher = new Pusher(soketi)
          await pusher.trigger(
            this.endpoint.channel,
            this.endpoint.event,
            this.value
          )

          break

        default:
          throw new Error(
            `Unknown webhook type for pending webhook ${
              this.id
            }, endpoint: ${JSON.stringify(this.endpoint)}`
          )
      }

      // Delete the pending webhook if request was successful.
      await this.destroy()
    } catch (err) {
      this.failures++

      console.error(
        `[PendingWebhook ${this.id}] failure #${this.failures}`,
        err
      )

      await this.save()

      throw err
    }
  }

  // Events must be loaded with `Contract` included.
  static async queueWebhooks(
    state: State,
    events: WasmEvent[]
  ): Promise<number> {
    const webhooks = getProcessedWebhooks(loadConfig(), state)
    if (webhooks.length === 0) {
      return 0
    }

    const pendingWebhooksToCreate = (
      await Promise.all(
        events.flatMap((event) => {
          const webhooksForEvent = webhooks.filter((webhook) =>
            webhook.filter(event)
          )

          return webhooksForEvent.map(async (webhook) => {
            const env: ContractEnv = {
              ...getEnv({
                block: event.block,
                cache: {
                  contracts: {
                    [event.contract.address]: event.contract,
                  },
                },
              }),
              contractAddress: event.contractAddress,
            }

            // Wrap in try/catch in case a webhook errors. Don't want to prevent
            // other webhooks from sending.
            let value
            try {
              value = await webhook.getValue(
                event,
                async () => {
                  // Find most recent event for this contract and key before
                  // this block.

                  // Check events in case the most recent event is in the
                  // current group of events.
                  const previousEvent = events
                    .filter(
                      (e) =>
                        e.contractAddress === event.contractAddress &&
                        e.key === e.key &&
                        e.blockHeight < event.blockHeight
                    )
                    .slice(-1)[0]

                  if (previousEvent) {
                    return previousEvent.delete ? null : previousEvent.valueJson
                  }

                  // Fallback to database.
                  const lastEvent = await event.getPreviousEvent()
                  return !lastEvent || lastEvent.delete
                    ? null
                    : lastEvent.valueJson
                },
                env
              )
            } catch (error) {
              // TODO: Store somewhere.
              console.error(
                `Error getting webhook value for event ${event.blockHeight}/${event.contractAddress}/${event.key}: ${error}`
              )
            }

            // Wrap in try/catch in case a webhook errors. Don't want to prevent
            // other webhooks from sending.
            let endpoint
            try {
              endpoint =
                typeof webhook.endpoint === 'function'
                  ? await webhook.endpoint(event, env)
                  : webhook.endpoint
            } catch (error) {
              // TODO: Store somewhere.
              console.error(
                `Error getting webhook endpoint for event ${event.blockHeight}/${event.contractAddress}/${event.key}: ${error}`
              )
            }

            // If value or endpoint is undefined, one either errored or the
            // function returned undefined. In either case, don't send a
            // webhook.
            if (value === undefined || endpoint === undefined) {
              return
            }

            return {
              eventId: event.id,
              endpoint,
              value,
              failures: 0,
            }
          })
        })
      )
    ).filter(
      (
        w
      ): w is {
        eventId: number
        endpoint: WebhookEndpoint
        value: any
        failures: number
      } => w !== undefined
    )

    if (!pendingWebhooksToCreate.length) {
      return 0
    }

    return (await PendingWebhook.bulkCreate(pendingWebhooksToCreate)).length
  }
}
