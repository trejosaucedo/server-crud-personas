export interface CreatePersonaRequestDto {
  nombre: string
  apellido_paterno: string
  apellido_materno: string
  edad: number
  genero: 'masculino' | 'femenino'
}

export interface UpdatePersonaRequestDto extends Partial<CreatePersonaRequestDto> {}

export interface PersonaResponseDto {
  id: string
  nombre: string
  apellido_paterno: string
  apellido_materno: string
  edad: number
  genero: 'masculino' | 'femenino'
}

export interface PaginatedPersonasResponseDto {
  data: PersonaResponseDto[]
  meta: {
    total: number
    perPage: number
    currentPage: number
    lastPage: number
  }
}

export interface ChartStatsDto {
  grafica1: { hombres: number; mujeres: number }
  grafica2: { adultos: number; menores: number }
  grafica3: {
    mujeres_menores: number
    mujeres_mayores: number
    hombres_mayores: number
    hombres_menores: number
  }
}
