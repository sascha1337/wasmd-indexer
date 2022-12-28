import { Contract, ContractComputation, Event, loadDb } from '../db'
import { computeContractRange } from './compute'
import { getContractFormula } from './utils'

export const preCompute = async (
  contractAddress: string,
  formulaNames: string[],
  // Args for formulas that require them. Map of formula name to args.
  formulaNameArgsMap?: Record<string, Record<string, string>>
) => {
  await loadDb()

  const contract = await Contract.findOne({
    where: { address: contractAddress },
  })
  if (!contract) {
    throw new Error(`Contract not found: ${contractAddress}`)
  }

  const earliestEvent = await Event.findOne({
    where: {
      contractAddress,
    },
    order: [['blockHeight', 'ASC']],
  })
  if (!earliestEvent) {
    throw new Error(`No events found for ${contractAddress}}`)
  }

  const latestEvent = await Event.findOne({
    where: {
      contractAddress,
    },
    order: [['blockHeight', 'DESC']],
  })
  if (!latestEvent) {
    throw new Error(`No events found for ${contractAddress}}`)
  }

  for (const formulaName of formulaNames) {
    const formula = getContractFormula(formulaName)
    if (!formula) {
      continue
    }

    const args = formulaNameArgsMap?.[formulaName] ?? {}

    const outputs = await computeContractRange(
      formula,
      contract,
      args,
      earliestEvent.block,
      latestEvent.block
    )

    // Store computations in DB.
    if (outputs.length > 0) {
      await ContractComputation.createFromComputationOutputs(
        contractAddress,
        formulaName,
        args,
        ...outputs
      )
    }
  }
}
