import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'personas'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary()
      table.string('nombre').notNullable()
      table.string('apellido_paterno').notNullable()
      table.string('apellido_materno').notNullable()
      table.integer('edad').notNullable()
      table.enu('genero', ['masculino', 'femenino']).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
      table.timestamp('deleted_at', { useTz: true }).nullable() // <= NUEVO
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
