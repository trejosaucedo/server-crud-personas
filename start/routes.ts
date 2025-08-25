import router from '@adonisjs/core/services/router'
import { PlotStream } from '#services/plot_stream'
const PlotsController = () => import('#controllers/plots_controller')

router.post('/plots/ingest', [PlotsController, 'ingest'])
router.get('/plots/filter', [PlotsController, 'filter'])
router.get('/plots/latest', [PlotsController, 'latest'])
router.get('/servers', [PlotsController, 'servers'])
router.get('/', async () => ({ ok: true, service: 'bot-brainrot', time: new Date().toISOString() }))
router.get('/health', async () => ({ ok: true }))

// NUEVO: guarda en memoria (API) qué nombre(s) vigilar. No usa DB.
router.post('/plots/find', async ({ request, response }) => {
  const term = String(
    request.input('q') ?? request.input('term') ?? request.input('name') ?? ''
  ).trim()

  if (!term) {
    return response.badRequest({ ok: false, error: 'Falta "q" (o "term"/"name") en el body.' })
  }

  const stream = PlotStream.getInstance()
  stream.addWatchTerm(term) // guarda en RAM (singleton)
  return response.ok({ ok: true, watching: stream.getWatchTerms() })
})
