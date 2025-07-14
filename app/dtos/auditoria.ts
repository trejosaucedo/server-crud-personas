export interface AuditoriaLogDto {
  accion: 'crear' | 'actualizar' | 'eliminar'
  entidad: string
  personaId: string
  usuarioId?: string | null
  usuario?: string | null
  fecha: Date
  datos: any
}
