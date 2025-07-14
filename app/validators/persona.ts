import vine from '@vinejs/vine'

export const createPersonaValidator = vine.compile(
  vine.object({
    nombre: vine.string().minLength(2),
    apellido_paterno: vine.string().minLength(2),
    apellido_materno: vine.string().minLength(2),
    edad: vine.number().min(0).max(120),
    genero: vine.enum(['masculino', 'femenino']),
  })
)

export const updatePersonaValidator = vine.compile(
  vine.object({
    nombre: vine.string().minLength(2).optional(),
    apellido_paterno: vine.string().minLength(2).optional(),
    apellido_materno: vine.string().minLength(2).optional(),
    edad: vine.number().min(0).max(120).optional(),
    genero: vine.enum(['masculino', 'femenino']).optional(),
  })
)
