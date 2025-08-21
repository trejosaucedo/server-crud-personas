// start/routes.ts
import router from '@adonisjs/core/services/router'
const PlotsController = () => import('#controllers/plots_controller')

router.post('/plots/ingest', [PlotsController, 'ingest'])
router.get('/plots/filter', [PlotsController, 'filter'])
router.get('/plots/latest', [PlotsController, 'latest'])
router.get('/', async () => ({ ok: true, service: 'bot-brainrot', time: new Date().toISOString() }))
router.get('/health', async () => ({ ok: true }))
