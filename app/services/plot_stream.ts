import axios from 'axios'
import env from '#start/env'

type Generation = { raw: string; perSecond: number | null; ready: boolean }
type AnimalEmpty = { index: number | string; empty: true }
type AnimalFull = {
  index: number | string
  empty: false
  displayName: string
  mutation: string
  rarity: string
  generation: Generation
}
type AnimalPodium = AnimalEmpty | AnimalFull
type Plot = {
  plotSign: string
  remainingTime: { raw: string | null; seconds: number | null }
  animalPodiums: AnimalPodium[]
  meta: { timestamp: string }
}
type ChannelParams = {
  minSecret?: number
  maxSecret?: number
  minNonSecret?: number
  maxNonSecret?: number
}

export class PlotStream {
  private static instance: PlotStream
  private watchMap = new Map<string, { term: string; mutation: string }>()
  private static FIND_WEBHOOK =
    'https://discord.com/api/webhooks/1409373921320505344/3S3KykiDshWzhSjfCRs-j_txEMyzV8IhURqL3LJYGWxQLHF7irzDzzFugX2AuQACSdOk'
  private static MIN_NON_SECRET = 500_000
  private static RAINBOW_5M = 2_500_000
  private static MAX_TEST = 2_500_000
  private static MAX_FIELDS_PER_EMBED = 25
  private static MAX_EMBEDS_PER_MESSAGE = 10
  private static MAX_FIELD_VALUE = 1024
  private static MAX_EMBED_CHARS = 5500
  private static PUBLIC_PARAMS: ChannelParams = {
    minSecret: 300_000,
    maxSecret: PlotStream.MAX_TEST,
    minNonSecret: PlotStream.MIN_NON_SECRET,
    maxNonSecret: PlotStream.MAX_TEST,
  }
  private static FIVE_M_PARAMS: ChannelParams = {
    minSecret: PlotStream.RAINBOW_5M,
    maxSecret: undefined,
    minNonSecret: PlotStream.RAINBOW_5M,
    maxNonSecret: undefined,
  }
  private static FINDER66_PARAMS: ChannelParams = {
    minSecret: 300_000,
    maxSecret: PlotStream.MAX_TEST,
    minNonSecret: PlotStream.MIN_NON_SECRET,
    maxNonSecret: PlotStream.MAX_TEST,
  }

  static getInstance() {
    if (!this.instance) this.instance = new PlotStream()
    return this.instance
  }

  private norm(s: any) {
    return String(s ?? '').trim().toLowerCase()
  }
  private normMut(s: any) {
    return this.norm(s)
  }
  private watchKey(term: string, mutation: string) {
    return `${term}|${mutation}`
  }

  addWatch(termRaw: string, mutationRaw?: string | null) {
    const term = this.norm(termRaw)
    const mutation = this.normMut(mutationRaw)
    if (!term) return null
    const key = this.watchKey(term, mutation)
    this.watchMap.set(key, { term, mutation })
    return { term, mutation }
  }

  removeWatch(termRaw: string, mutationRaw?: string | null) {
    const term = this.norm(termRaw)
    const mutation = this.normMut(mutationRaw)
    if (!term) return false
    return this.watchMap.delete(this.watchKey(term, mutation))
  }

  clearWatch() {
    this.watchMap.clear()
  }
  getWatchList() {
    return Array.from(this.watchMap.values())
  }

  private parseHumanMoney(input: string | number | undefined): number | null {
    if (input === undefined || input === null) return null
    if (typeof input === 'number') return Number.isFinite(input) ? input : null
    const raw = String(input).trim().toLowerCase()
    if (raw === '') return null
    const m = raw.match(/^(\d+(?:\.\d+)?)([kmbt])$/i)
    if (m) {
      const num = Number.parseFloat(m[1])
      const suf = m[2].toLowerCase()
      const mult = suf === 'k' ? 1e3 : suf === 'm' ? 1e6 : suf === 'b' ? 1e9 : suf === 't' ? 1e12 : 1
      return num * mult
    }
    const asNum = Number(raw)
    if (!Number.isNaN(asNum)) return asNum
    return null
  }

  private meetsChannelThresholds(item: { p: number; rarity?: string }, cfg: ChannelParams): boolean {
    const isSecret = item.rarity === 'Secret'
    const min = isSecret ? cfg.minSecret : cfg.minNonSecret
    const max = isSecret ? cfg.maxSecret : cfg.maxNonSecret
    if (typeof min === 'number' && item.p < min) return false
    if (typeof max === 'number' && item.p > max) return false
    return true
  }

  async emitToDiscord(jobId: string, plots: Plot[]) {
    const hookPublic = env.get('DISCORD_WEBHOOK_PUBLIC') || null
    const hook5m =
      'https://discord.com/api/webhooks/1407888137669312552/RGgCno4t0JwLn0sHUc2FbG089D0yZdrxjdTVHPAh2fGacIqILMByO0UipRiCv-zPoLuK'
    const hookFinder66 = env.get('DISCORD_WEBHOOK_FINDER66') || null
    if (!hookPublic && !hook5m && !hookFinder66 && this.watchMap.size === 0) return

    type Item = { name: string; p: number; plot: string; rarity?: string }
    const all: Item[] = []
    for (const plot of plots) {
      for (const ap of plot.animalPodiums) {
        const anyAp = ap as any
        if (anyAp?.empty) continue
        const a = ap as any
        let p: number | null = null
        const rawP = a?.generation?.perSecond
        if (typeof rawP === 'number' && Number.isFinite(rawP)) p = rawP
        else if (typeof rawP === 'string') {
          const cleaned = rawP.trim().replace(/\/s$/i, '').replace(/^\$/, '')
          p = this.parseHumanMoney(cleaned)
        }
        if (p === null) continue
        all.push({ name: a.displayName, p, plot: plot.plotSign, rarity: a.rarity })
      }
    }

    const channels = [
      { name: '+5M', webhook: hook5m, badge: '+5M', ...PlotStream.FIVE_M_PARAMS },
      { name: 'Finder66', webhook: hookFinder66, badge: 'Finder66', ...PlotStream.FINDER66_PARAMS },
      { name: 'Public', webhook: hookPublic, badge: 'Public', ...PlotStream.PUBLIC_PARAMS },
    ] as const

    let chosenWebhook: string | null = null
    let chosenBadge: string | undefined
    let chosenItems: Item[] = []

    if (all.length && (hookPublic || hook5m || hookFinder66)) {
      for (const ch of channels) {
        if (!ch.webhook) continue
        const eligible = all.filter((it) => this.meetsChannelThresholds(it, ch))
        if (eligible.length) {
          chosenWebhook = ch.webhook
          chosenBadge = ch.badge
          chosenItems = eligible
          break
        }
      }
      if (chosenWebhook && chosenItems.length) {
        const embeds = this.buildEmbedsMarkdown(jobId, chosenItems, { scopeBadge: chosenBadge })
        await this.postInChunks([chosenWebhook], embeds)
      }
    }

    await this.scanAndEmitWatches(jobId, plots)
  }

  private buildEmbedsMarkdown(
    jobId: string,
    itemsRaw: Array<{ name: string; p: number; plot: string; rarity?: string }>,
    opts?: { scopeBadge?: string }
  ) {
    const items = [...itemsRaw].sort((a, b) => b.p - a.p)
    const counts = new Map<string, number>()
    for (const it of items) {
      const bucket = it.rarity === 'Secret' ? 'Secretos' : it.rarity ?? 'Otros'
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
    }
    const barParts: string[] = []
    if (counts.has('Secretos')) barParts.push(`Secretos ${counts.get('Secretos')}`)
    for (const [k2, v2] of [...counts.entries()]
      .filter(([k3]) => k3 !== 'Secretos')
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      barParts.push(`${k2} ${v2}`)
    }

    type Row = { name: string; p: number; rarity: string }
    type Group = { byRarity: Map<string, Row[]> }
    const byPlot = new Map<string, Group>()
    for (const it of items) {
      const g = byPlot.get(it.plot) ?? { byRarity: new Map() }
      const rarity = it.rarity && it.rarity.trim() ? it.rarity : 'Otros'
      const arr = g.byRarity.get(rarity) ?? []
      arr.push({ name: it.name, p: it.p, rarity })
      g.byRarity.set(rarity, arr)
      byPlot.set(it.plot, g)
    }

    const orderedPlots = [...byPlot.entries()].sort((a, b) => {
      const bestA = Math.max(...[...a[1].byRarity.values()].flat().map((x) => x.p))
      const bestB = Math.max(...[...b[1].byRarity.values()].flat().map((x) => x.p))
      return bestB - bestA
    })

    const best = items[0]
    const TRIANGLES = '△▽△▽△▽△▽△▽△▽△▽△▽ △▽△▽△▽△▽△▽△▽△▽△▽'
    const descriptionParts = [
      '**JOB ID**',
      '```' + jobId + '```',
      TRIANGLES,
      '',
      best ? `**Mejor:** ${best.name} — **${this.human(best.p)}/s** — ${best.rarity ?? 'Otros'}` : null,
      `**TOTAL:** ${items.length}`,
      barParts.length ? barParts.join(' | ') : null,
    ].filter(Boolean) as string[]
    const descriptionJoined = descriptionParts.join('\n')
    const description =
      descriptionJoined.length > 1024 ? descriptionJoined.slice(0, 1021) + '…' : descriptionJoined

    const rarityHeader = (rarity: string) => `**${rarity.trim()}**`
    const fields: Array<{ name: string; value: string; inline?: boolean }> = []

    for (const [plotName, group] of orderedPlots) {
      const raritiesOrdered = [...group.byRarity.entries()].sort((a, b) => {
        const maxA = Math.max(...a[1].map((x) => x.p))
        const maxB = Math.max(...b[1].map((x) => x.p))
        return maxB - maxA
      })
      raritiesOrdered.forEach(([rarity, arr], idx) => {
        const rows = arr
          .sort((a, b) => b.p - a.p)
          .map((it) => `• ${it.name} — **${this.human(it.p)}/s**`)
          .join('\n')
        const fieldName = idx === 0 ? `__**${plotName}**__` : '\u200B'
        const value = `${rarityHeader(rarity)}${rows ? '\n' + rows : ''}`
        fields.push({
          name: fieldName,
          value: value.length > PlotStream.MAX_FIELD_VALUE ? value.slice(0, PlotStream.MAX_FIELD_VALUE - 1) + '…' : value,
          inline: false,
        })
      })
    }

    const title = opts?.scopeBadge ? `SauNotify • ${opts.scopeBadge}` : 'SauNotify'
    return this.packEmbeds(title, description, fields)
  }

  private packEmbeds(
    title: string,
    description: string,
    fields: Array<{ name: string; value: string; inline?: boolean }>
  ) {
    const embeds: any[] = []
    let current = this.newEmbed(title, description)
    let fieldCount = 0
    let chars = this.embedSize(current)
    for (const f of fields) {
      const chunks = this.chunkFieldValue(f.value, PlotStream.MAX_FIELD_VALUE)
      for (const [i, chunk] of chunks.entries()) {
        const name = i === 0 ? f.name : `${f.name} (cont.)`
        const field = { name, value: chunk, inline: false }
        const addSize = name.length + chunk.length + 10
        const wouldOverflow =
          fieldCount >= PlotStream.MAX_FIELDS_PER_EMBED || chars + addSize > PlotStream.MAX_EMBED_CHARS
        if (wouldOverflow) {
          if (current.fields.length) embeds.push(current)
          current = this.newEmbed(title + ` (cont.)`, description)
          fieldCount = 0
          chars = this.embedSize(current)
        }
        current.fields.push(field)
        fieldCount++
        chars += addSize
      }
    }
    if (current.fields.length) embeds.push(current)
    return embeds
  }

  private newEmbed(title: string, description: string) {
    return {
      title,
      description,
      fields: [] as any[],
      footer: {
        text: `SauNotify • ${new Intl.DateTimeFormat('es-MX', {
          dateStyle: 'short',
          timeStyle: 'medium',
          timeZone: 'America/Monterrey',
        }).format(new Date())} America/Monterrey • by qsau`,
      },
    }
  }

  private embedSize(e: any) {
    const fieldsLen = e.fields.reduce((a: number, f: any) => a + f.name.length + f.value.length, 0)
    return (e.title?.length ?? 0) + (e.description?.length ?? 0) + fieldsLen + 50
  }

  private chunkFieldValue(s: string, max: number) {
    if (s.length <= max) return [s]
    const out: string[] = []
    let i = 0
    while (i < s.length) {
      out.push(s.slice(i, i + max))
      i += max
    }
    return out
  }

  private async postInChunks(urls: string[], embeds: any[]) {
    if (!urls.length || !embeds.length) return
    for (const url of urls) {
      let i = 0
      while (i < embeds.length) {
        const slice = embeds.slice(i, i + PlotStream.MAX_EMBEDS_PER_MESSAGE)
        await this.safePost(url, { embeds: slice })
        i += PlotStream.MAX_EMBEDS_PER_MESSAGE
      }
    }
  }

  private async safePost(url: string, payload: any) {
    try {
      const r = await axios.post(url, payload, { validateStatus: () => true })
      if (r.status < 200 || r.status >= 300) {
        if (r.status === 429) {
          const retry = Number(r.headers?.['retry-after'] ?? 0)
          if (retry > 0 && retry < 10_000) await new Promise((res) => setTimeout(res, retry * 1000))
        }
      }
    } catch {}
  }

  private human(n: number): string {
    if (n >= 1e12) return `${+(n / 1e12).toFixed(3)}T`
    if (n >= 1e9) return `${+(n / 1e9).toFixed(3)}B`
    if (n >= 1e6) return `${+(n / 1e6).toFixed(3)}M`
    if (n >= 1e3) return `${+(n / 1e3).toFixed(3)}K`
    return `${+n.toFixed(3)}`
  }

  private async scanAndEmitWatches(jobId: string, plots: Plot[]) {
    if (this.watchMap.size === 0) return
    type Item = { name: string; p: number; plot: string; rarity?: string }
    const items: Item[] = []
    for (const plot of plots) {
      for (const ap of plot.animalPodiums) {
        const anyAp = ap as any
        if (anyAp?.empty) continue
        const a = ap as any
        const name = String(a?.displayName || '')
        if (!name) continue
        const nameLow = this.norm(name)
        const itemMut = this.normMut(a?.mutation)
        let matched = false
        for (const { term, mutation } of this.watchMap.values()) {
          if (!nameLow.includes(term)) continue
          const okMut = mutation === '' ? itemMut === '' : itemMut === mutation
          if (okMut) {
            matched = true
            break
          }
        }
        if (!matched) continue
        let p: number | null = null
        const rawP = a?.generation?.perSecond
        if (typeof rawP === 'number' && Number.isFinite(rawP)) p = rawP
        else if (typeof rawP === 'string') {
          const cleaned = rawP.trim().replace(/\/s$/i, '').replace(/^\$/, '')
          p = this.parseHumanMoney(cleaned)
        }
        items.push({
          name,
          p: p ?? 0,
          plot: plot.plotSign,
          rarity: a?.rarity,
        })
      }
    }
    if (!items.length) return
    const embeds = this.buildEmbedsMarkdown(jobId, items, { scopeBadge: 'Find' })
    await this.postInChunks([PlotStream.FIND_WEBHOOK], embeds)
  }
}
