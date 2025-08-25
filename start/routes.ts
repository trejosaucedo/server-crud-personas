import router from '@adonisjs/core/services/router'
import { PlotStream } from '#services/plot_stream'
const PlotsController = () => import('#controllers/plots_controller')

router.post('/plots/ingest', [PlotsController, 'ingest'])
router.get('/plots/filter', [PlotsController, 'filter'])
router.get('/plots/latest', [PlotsController, 'latest'])
router.get('/servers', [PlotsController, 'servers'])
router.get('/', async () => ({ ok: true, service: 'bot-brainrot', time: new Date().toISOString() }))
router.get('/health', async () => ({ ok: true }))


router.post('/plots/find', async ({ request, response }) => {
  const term = String(
    request.input('q') ?? request.input('term') ?? request.input('name') ?? ''
  ).trim()
  const mutation = request.input('mutation') ?? request.input('mut') ?? null // null -> se normaliza a '' (sin mutation)
  if (!term) return response.badRequest({ ok: false, error: 'Falta "q" (o "term"/"name")' })

  const stream = PlotStream.getInstance()
  const added = stream.addWatch(term, mutation)
  return response.ok({ ok: true, added, watching: stream.getWatchList() })
})

router.delete('/plots/find', async ({ request, response }) => {
  const term = String(
    request.input('q') ?? request.input('term') ?? request.input('name') ?? ''
  ).trim()
  const mutation = request.input('mutation') ?? request.input('mut') ?? null
  if (!term) return response.badRequest({ ok: false, error: 'Falta "q" (o "term"/"name")' })

  const stream = PlotStream.getInstance()
  const removed = stream.removeWatch(term, mutation)
  return response.ok({ ok: true, removed, watching: stream.getWatchList() })
})

// === WATCHLIST: limpiar todo
router.delete('/plots/find/all', async ({ response }) => {
  const stream = PlotStream.getInstance()
  stream.clearWatch()
  return response.ok({ ok: true, watching: [] })
})
