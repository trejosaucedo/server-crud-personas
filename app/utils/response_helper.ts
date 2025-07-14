import type { HttpContext } from '@adonisjs/core/http'

export class ResponseHelper {
  static success<T>(response: HttpContext['response'], message: string, data?: T, status = 200) {
    const resp: any = { success: true, message }
    if (typeof data !== 'undefined') resp.data = data
    return response.status(status).json(resp)
  }

  static error<T = null>(
    response: HttpContext['response'],
    message: string,
    status = 400,
    data?: T
  ) {
    const resp: any = { success: false, message }
    if (typeof data !== 'undefined') resp.data = data
    return response.status(status).json(resp)
  }
}
