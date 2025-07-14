import router from '@adonisjs/core/services/router'
const AuthController = () => import('#controllers/auth_controller')
const PersonaController = () => import('#controllers/personas_controller')
import { middleware } from './kernel.js'

// Rutas públicas de autenticación
router.post('/register', [AuthController, 'register'])
router.post('/login', [AuthController, 'login'])

// Rutas protegidas de autenticación y personas
router
  .group(() => {
    router.post('/logout', [AuthController, 'logout'])
    router.get('/me', [AuthController, 'me'])
    router.get('/personas/auditorias', [PersonaController, 'auditoriasPersonas'])
    router.get('/personas', [PersonaController, 'index'])
    router.get('/personas/:id', [PersonaController, 'show'])
    router.post('/personas', [PersonaController, 'store'])
    router.put('/personas/:id', [PersonaController, 'update'])
    router.delete('/personas/:id', [PersonaController, 'destroy'])
    router.get('/personas-stats', [PersonaController, 'stats'])
  })
  .use(middleware.auth())
