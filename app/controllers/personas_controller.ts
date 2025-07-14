import type { HttpContext } from '@adonisjs/core/http'
import { PersonaService } from '#services/persona_service'
import { ResponseHelper } from '#utils/response_helper'
import { createPersonaValidator, updatePersonaValidator } from '#validators/persona'
import { obtenerAuditorias, registrarAuditoria } from '#services/auditoria_service'

export default class PersonasController {
  private personaService = new PersonaService()

  async index({ request, response }: HttpContext) {
    try {
      const page = Number(request.input('page', 1))
      const limit = Number(request.input('limit', 10))
      const personas = await this.personaService.paginate(page, limit)
      return ResponseHelper.success(response, 'Lista de personas', personas)
    } catch (error) {
      return ResponseHelper.error(response, 'Error al obtener personas', 500, error)
    }
  }

  async stats({ response }: HttpContext) {
    try {
      const stats = await this.personaService.getChartStats()
      return ResponseHelper.success(response, 'Datos para gráficas', stats)
    } catch (error) {
      return ResponseHelper.error(response, 'Error al obtener datos de gráficas', 500, error)
    }
  }

  async store({ request, response, user }: HttpContext) {
    console.log('ENTRO A STORE')
    try {
      const payload = await request.validateUsing(createPersonaValidator)
      console.log('PAYLOAD', payload)
      const persona = await this.personaService.create(payload)
      await registrarAuditoria({
        accion: 'crear',
        entidad: 'persona',
        personaId: persona.id,
        usuario: user?.name ?? null,
        usuarioId: user?.id ?? null,
        fecha: new Date(),
        datos: persona,
      })
      return ResponseHelper.success(response, 'Persona creada exitosamente', persona, 201)
    } catch (error) {
      console.error('ERROR EN STORE', error)
      return ResponseHelper.error(response, 'Error al crear persona', 400, error)
    }
  }

  async show({ params, response }: HttpContext) {
    try {
      const persona = await this.personaService.getById(params.id)
      if (!persona) return ResponseHelper.error(response, 'Persona no encontrada SHOW', 404)
      return ResponseHelper.success(response, 'Persona encontrada', persona)
    } catch (error) {
      return ResponseHelper.error(response, 'Error al obtener persona', 400, error)
    }
  }

  async update({ params, request, response, user }: HttpContext) {
    try {
      const payload = await request.validateUsing(updatePersonaValidator)
      const persona = await this.personaService.update(params.id, payload)
      if (!persona) return ResponseHelper.error(response, 'Persona no encontrada UPDATE', 404)
      await registrarAuditoria({
        accion: 'actualizar',
        entidad: 'persona',
        personaId: persona.id,
        usuario: user?.name ?? null,
        usuarioId: user?.id ?? null,
        fecha: new Date(),
        datos: persona,
      })
      return ResponseHelper.success(response, 'Persona actualizada exitosamente', persona)
    } catch (error) {
      return ResponseHelper.error(response, 'Error al actualizar persona', 400, error)
    }
  }

  async destroy({ params, response, user }: HttpContext) {
    try {
      const ok = await this.personaService.delete(params.id)
      if (!ok) return ResponseHelper.error(response, 'Persona no encontrada DESTROY', 404)
      await registrarAuditoria({
        accion: 'eliminar',
        entidad: 'persona',
        personaId: params.id,
        usuario: user?.name ?? null,
        usuarioId: user?.id ?? null,
        fecha: new Date(),
        datos: null,
      })
      return ResponseHelper.success(response, 'Persona eliminada exitosamente')
    } catch (error) {
      return ResponseHelper.error(response, 'Error al eliminar persona', 400, error)
    }
  }

  async auditoriasPersonas({ response }: HttpContext) {
    try {
      const auditorias = await obtenerAuditorias()
      return ResponseHelper.success(response, 'Lista de auditorías', auditorias)
    } catch (error) {
      return ResponseHelper.error(response, 'Error al obtener auditorías', 500, error)
    }
  }
}
