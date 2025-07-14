import { DateTime } from 'luxon'
import { BaseModel, column, beforeCreate } from '@adonisjs/lucid/orm'
import { v4 as uuidv4 } from 'uuid'

export default class Persona extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare nombre: string

  @column()
  declare apellido_paterno: string

  @column()
  declare apellido_materno: string

  @column()
  declare edad: number

  @column()
  declare genero: 'masculino' | 'femenino'

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @column.dateTime()
  declare deletedAt: DateTime | null

  @beforeCreate()
  static assignUuid(persona: Persona) {
    persona.id = uuidv4()
  }
}
