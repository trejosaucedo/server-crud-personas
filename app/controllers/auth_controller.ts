import type { HttpContext } from '@adonisjs/core/http'
import { UserService } from '#services/user_service'
import { ResponseHelper } from '#utils/response_helper'
import { registerValidator, loginValidator } from '#validators/auth'

export default class AuthController {
  private userService = new UserService()

  async register({ request, response }: HttpContext) {
    try {
      const payload = await request.validateUsing(registerValidator)
      const result = await this.userService.register(payload)
      return ResponseHelper.success(response, 'Registro exitoso', result, 201)
    } catch (error) {
      return ResponseHelper.error(response, 'No se pudo registrar usuario', 400, error)
    }
  }

  async login({ request, response }: HttpContext) {
    console.log(request.body())
    try {
      const payload = await request.validateUsing(loginValidator)
      const result = await this.userService.login(payload)
      if (!result) {
        return ResponseHelper.error(response, 'Credenciales inválidas', 401)
      }
      return ResponseHelper.success(response, 'Login exitoso', result)
    } catch (error) {
      return ResponseHelper.error(response, 'Error al iniciar sesión', 400, error)
    }
  }

  async me({ user, response }: HttpContext) {
    try {
      if (!user) {
        return ResponseHelper.error(response, 'No autenticado', 401)
      }
      return ResponseHelper.success(response, 'Usuario autenticado', { user })
    } catch (error) {
      return ResponseHelper.error(response, 'Error en /me', 400, error)
    }
  }

  async logout({ response }: HttpContext) {
    return ResponseHelper.success(response, 'Logout exitoso')
  }
}
