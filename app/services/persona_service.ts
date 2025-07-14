// app/services/persona_service.ts
import Persona from '#models/persona'
import { PersonaRepository } from '#repositories/persona_repository'
import type {
  CreatePersonaRequestDto,
  UpdatePersonaRequestDto,
  PersonaResponseDto,
  ChartStatsDto,
  PaginatedPersonasResponseDto,
} from '#dtos/persona'

export class PersonaService {
  private repo = new PersonaRepository()

  async paginate(page: number, limit: number): Promise<PaginatedPersonasResponseDto> {
    const result = await this.repo.paginate(page, limit)
    return {
      data: result.all() as PersonaResponseDto[],
      meta: {
        total: result.total,
        perPage: result.perPage,
        currentPage: result.currentPage,
        lastPage: result.lastPage,
      },
    }
  }

  async getById(id: string): Promise<PersonaResponseDto | null> {
    const persona = await this.repo.findById(id)
    return persona ? (persona.serialize() as PersonaResponseDto) : null
  }

  async create(dto: CreatePersonaRequestDto): Promise<PersonaResponseDto> {
    const persona = await this.repo.create(dto)
    return persona.serialize() as PersonaResponseDto
  }

  async update(id: string, dto: UpdatePersonaRequestDto): Promise<PersonaResponseDto | null> {
    const persona = await this.repo.update(id, dto)
    return persona ? (persona.serialize() as PersonaResponseDto) : null
  }

  async delete(id: string): Promise<boolean> {
    const persona = await this.repo.delete(id)
    return !!persona
  }

  async getChartStats(): Promise<ChartStatsDto> {
    const personas = (await this.repo.findAll()) as Persona[]
    const mujeres: Persona[] = personas.filter((p: Persona) => p.genero === 'femenino')
    const hombres: Persona[] = personas.filter((p: Persona) => p.genero === 'masculino')
    const mayores: Persona[] = personas.filter((p: Persona) => p.edad >= 18)
    const menores: Persona[] = personas.filter((p: Persona) => p.edad < 18)

    return {
      grafica1: {
        hombres: hombres.length,
        mujeres: mujeres.length,
      },
      grafica2: {
        adultos: mayores.length,
        menores: menores.length,
      },
      grafica3: {
        mujeres_menores: mujeres.filter((p: Persona) => p.edad < 18).length,
        mujeres_mayores: mujeres.filter((p: Persona) => p.edad >= 18).length,
        hombres_mayores: hombres.filter((p: Persona) => p.edad >= 18).length,
        hombres_menores: hombres.filter((p: Persona) => p.edad < 18).length,
      },
    }
  }
}
