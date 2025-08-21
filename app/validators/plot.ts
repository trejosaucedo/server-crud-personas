import vine from '@vinejs/vine'

/**
 * Sub-schemas
 */
const generationSchema = vine.object({
  raw: vine.string(),
  perSecond: vine.number().nullable(),
  ready: vine.boolean(),
})

const animalPodiumSchema = vine.object({
  index: vine.any(), // puede ser number o string
  empty: vine.boolean(),
  displayName: vine.string().optional(),
  mutation: vine.string().optional(),
  rarity: vine.string().optional(),
  generation: generationSchema.optional(),
})

const plotSchema = vine.object({
  plotSign: vine.string(),
  remainingTime: vine.object({
    raw: vine.string().nullable(),
    seconds: vine.number().nullable(),
  }),
  animalPodiums: vine.array(animalPodiumSchema),
  meta: vine.object({
    timestamp: vine.string(), // ISO
  }),
})

/**
 * Validator raíz: objeto con jobId + generatedAt + plots[]
 */
export const plotPayloadValidator = vine.compile(
  vine.object({
    jobId: vine.string(),
    generatedAt: vine.string(), // ISO datetime
    plots: vine.array(plotSchema),
  })
)
