import Persona from '#models/persona'
import type { CreatePersonaRequestDto, UpdatePersonaRequestDto } from '#dtos/persona'
import { DateTime } from 'luxon'

export class PersonaRepository {
  async paginate(page: number, limit: number) {
    return Persona.query().whereNull('deleted_at').paginate(page, limit)
  }

  async findAll() {
    return Persona.query().whereNull('deleted_at')
  }

  async findById(id: string) {
    return Persona.query().where('id', id).whereNull('deleted_at').first()
  }

  async create(data: CreatePersonaRequestDto) {
    return Persona.create(data)
  }

  async update(id: string, data: UpdatePersonaRequestDto) {
    const persona = await this.findById(id)
    if (!persona) return null
    persona.merge(data)
    await persona.save()
    return persona
  }

  async delete(id: string) {
    const persona = await this.findById(id)
    if (!persona) return null
    persona.deletedAt = DateTime.now()
    await persona.save()
    return persona
  }
}
