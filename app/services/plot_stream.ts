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

type JobPayload = {
  jobId: string
  generatedAt: string
  plots: Plot[]
}

type FilterQuery = {
  mutation?: string
  rarity?: string
  minPerSecond?: number
}

export class PlotStream {
  private static instance: PlotStream
  private buffer: { at: number; jobId: string; generatedAt: string; plots: Plot[] }[] = []
  private ttlMs = 60_000

  // ====== UMBRALES Y ESTILO ======
  private static MIN_NON_SECRET = 300_000 // TODOS los hooks: no-secret desde 300k/s
  private static RAINBOW_5M = 5_000_000 // 5M+: destacados y hook especial
  private static COLOR_DEFAULT = 0x95a5a6
  private static COLOR_RAINBOW = 0x2ecc71 // si hay ≥5M/s en el embed general
  private static COLOR_5M_ONLY = 0x0b63ff // azul fuerte para hook 5M

  // Límites Discord (automático: partimos en múltiples embeds/mensajes)
  private static MAX_FIELDS_PER_EMBED = 25
  private static MAX_EMBEDS_PER_MESSAGE = 10
  private static MAX_FIELD_VALUE = 1024
  private static MAX_EMBED_CHARS = 5500

  static getInstance() {
    if (!this.instance) this.instance = new PlotStream()
    return this.instance
  }

  pushPayload(payload: JobPayload) {
    const now = Date.now()
    this.buffer.push({
      at: now,
      jobId: payload.jobId,
      generatedAt: payload.generatedAt,
      plots: payload.plots,
    })
    this.gc(now)
  }

  dump(): Plot[] {
    this.gc(Date.now())
    const out: Plot[] = []
    for (const chunk of this.buffer) out.push(...chunk.plots)
    return out
  }

  dumpJobs(): JobPayload[] {
    this.gc(Date.now())
    return this.buffer.map((b) => ({ jobId: b.jobId, generatedAt: b.generatedAt, plots: b.plots }))
  }

  private gc(now = Date.now()) {
    const minTs = now - this.ttlMs
    this.buffer = this.buffer.filter((e) => e.at >= minTs)
  }

  parseHumanMoney(input: string | number | undefined): number | null {
    if (input === undefined || input === null) return null
    if (typeof input === 'number') return Number.isFinite(input) ? input : null
    const raw = String(input).trim().toLowerCase()
    if (raw === '') return null
    const m = raw.match(/^(\d+(?:\.\d+)?)([kmbt])$/i)
    if (m) {
      const num = Number.parseFloat(m[1])
      const suf = m[2].toLowerCase()
      const mult =
        suf === 'k' ? 1e3 : suf === 'm' ? 1e6 : suf === 'b' ? 1e9 : suf === 't' ? 1e12 : 1
      return num * mult
    }
    const asNum = Number(raw)
    if (!Number.isNaN(asNum)) return asNum
    return null
  }

  filter(q: FilterQuery) {
    const min = q.minPerSecond ?? null
    const out: Array<{
      plotSign: string
      index: number | string
      displayName: string
      mutation: string
      rarity: string
      generation: { raw: string; perSecond: number | null }
      timestamp: string
    }> = []
    for (const chunk of this.buffer) {
      for (const plot of chunk.plots) {
        for (const a of plot.animalPodiums) {
          if ((a as AnimalEmpty).empty) continue
          const full = a as AnimalFull
          if (q.mutation && full.mutation !== q.mutation) continue
          if (q.rarity && full.rarity !== q.rarity) continue
          const psec = full.generation?.perSecond ?? null
          if (min !== null) {
            if (psec === null || psec < min) continue
          } else {
            if (psec === null) continue
          }
          out.push({
            plotSign: plot.plotSign,
            index: full.index,
            displayName: full.displayName,
            mutation: full.mutation,
            rarity: full.rarity,
            generation: { raw: full.generation.raw, perSecond: psec },
            timestamp: plot.meta.timestamp,
          })
        }
      }
    }
    return out
  }

  /**
   * - Hook CARLOS (DISCORD_WEBHOOK_CARLOS): Secretos (siempre) + no-secret ≥ 300k/s
   * - Hook TEST   (DISCORD_WEBHOOK_TEST):   igual que CARLOS (para validar)
   * - Hook 5M     (DISCORD_WEBHOOK_5M):     SOLO ≥ 5M/s (azul fuerte + letras blancas con ANSI)
   */
  async emitToDiscord(jobId: string, plots: Plot[]) {
    const hookCarlos = env.get('DISCORD_WEBHOOK_CARLOS')
    const hookTest = env.get('DISCORD_WEBHOOK_TEST')
    const hook5m = env.get('DISCORD_WEBHOOK_5M')

    type Item = { name: string; p: number; plot: string; rarity?: string }
    const all: Item[] = []

    for (const plot of plots) {
      for (const ap of plot.animalPodiums) {
        const anyAp = ap as any
        if (anyAp.empty) continue
        const a = ap as AnimalFull
        const p = a.generation?.perSecond
        if (typeof p !== 'number') continue
        all.push({ name: a.displayName, p, plot: plot.plotSign, rarity: a.rarity })
      }
    }
    if (!all.length) return

    // === Conjuntos ===
    const eligible300k = all.filter(
      (i) => i.rarity === 'Secret' || i.p >= PlotStream.MIN_NON_SECRET
    )
    const only5m = all.filter((i) => i.p >= PlotStream.RAINBOW_5M)

    // === CARLOS / TEST (≥300k + secretos) ===
    if (eligible300k.length) {
      const embeds = this.buildEmbedsPretty(jobId, eligible300k, { strongBlueHeaderIfHas5m: true })
      await this.postInChunks([hookCarlos, hookTest].filter(Boolean) as string[], embeds)
    }

    // === 5M ONLY (azul fuerte + ANSI fondo azul/blanco) ===
    if (only5m.length && hook5m) {
      const embeds5m = this.buildEmbedsPretty(jobId, only5m, {
        forceBlue: true,
        titleSuffix: ' • 5M+ ONLY',
        fiveMAnsiBanner: true,
      })
      await this.postInChunks([hook5m], embeds5m)
    }
  }

  // ===================== RENDER “BONITO” =====================
  private buildEmbedsPretty(
    jobId: string,
    itemsRaw: Array<{ name: string; p: number; plot: string; rarity?: string }>,
    opts?: {
      titleSuffix?: string
      strongBlueHeaderIfHas5m?: boolean
      forceBlue?: boolean
      fiveMAnsiBanner?: boolean
    }
  ) {
    let items = [...itemsRaw].sort((a, b) => b.p - a.p)
    const has5m = items.some((i) => i.p >= PlotStream.RAINBOW_5M)

    // Resumen por rareza (Secretos primero)
    const counts = new Map<string, number>()
    for (const it of items) {
      const key = it.rarity === 'Secret' ? 'Secretos' : (it.rarity ?? 'Otros')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const summaryParts: string[] = []
    if (counts.has('Secretos')) summaryParts.push(`Secretos ${counts.get('Secretos')}`)
    const rest = [...counts.entries()]
      .filter(([k]) => k !== 'Secretos')
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    for (const [k, v] of rest) summaryParts.push(`${k} ${v}`)

    // Top banner 5M+ (si procede) — separamos para no duplicar en grupos
    const top5m = items.filter((i) => i.p >= PlotStream.RAINBOW_5M)
    const below5m = items.filter((i) => i.p < PlotStream.RAINBOW_5M)

    // Agrupar por plot el resto
    type Group = {
      secrets: Array<{ name: string; p: number }>
      normalsByRarity: Map<string, Array<{ name: string; p: number }>>
    }
    const byPlot = new Map<string, Group>()
    const pushGroup = (plot: string, rarity: string | undefined, name: string, p: number) => {
      const g = byPlot.get(plot) ?? { secrets: [], normalsByRarity: new Map() }
      if (rarity === 'Secret') {
        // @ts-ignore
        g.secrets.push({ name, p })
      } else {
        const r = rarity && rarity.trim() ? rarity : 'Otros'
        const arr = g.normalsByRarity.get(r) ?? []
        arr.push({ name, p })
        g.normalsByRarity.set(r, arr)
      }
      byPlot.set(plot, g)
    }
    for (const it of below5m) pushGroup(it.plot, it.rarity, it.name, it.p)
    // (Si quieres ver también 5M dentro del plot, comenta la siguiente línea y deja que entren con pushGroup)
    // for (const it of top5m) pushGroup(it.plot, it.rarity, it.name, it.p)

    // Orden plots por mejor p/s
    const orderedPlots = [...byPlot.entries()].sort((a, b) => {
      const bestA = Math.max(
        0,
        ...a[1].secrets.map((x) => x.p),
        ...[...a[1].normalsByRarity.values()].flat().map((x) => x.p)
      )
      const bestB = Math.max(
        0,
        ...b[1].secrets.map((x) => x.p),
        ...[...b[1].normalsByRarity.values()].flat().map((x) => x.p)
      )
      return bestB - bestA
    })

    // ==== Construimos fields ====
    const fields: Array<{ name: string; value: string; inline?: boolean }> = []

    // 5M banner (ANSI fondo azul / letra blanca)
    if (top5m.length) {
      const lines = top5m.map((i) =>
        this.ansiBlueWhite(` ${i.name} — ${this.human(i.p)}/s — ${i.plot} `)
      )
      const block = this.wrapAnsi(lines.join('\n'))
      fields.push({ name: '⚡ 5M+ DESTACADOS', value: block, inline: false })
    }

    // Por plot
    for (const [plotName, group] of orderedPlots) {
      const lines: string[] = []

      // Secretos (blanco remarcado, ANSI bright white + bold)
      if (group.secrets.length) {
        const sec = [...group.secrets].sort((a, b) => b.p - a.p)
        const sLines = sec.map((it) => this.ansiWhiteBold(` ¬ ${it.name} — ${this.human(it.p)}/s `))
        lines.push('**Secretos**')
        lines.push(this.wrapAnsi(sLines.join('\n')))
      }

      // Rarities no-secret
      const orderedRarities = [...group.normalsByRarity.entries()].sort((a, b) => {
        const maxA = Math.max(...a[1].map((x) => x.p))
        const maxB = Math.max(...b[1].map((x) => x.p))
        return maxB - maxA
      })

      for (const [rarity, arr] of orderedRarities) {
        const arrSorted = [...arr].sort((a, b) => b.p - a.p)
        if (rarity === 'Brainrot God') {
          // varios colores (cíclico)
          const palette = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 95, 96] // ANSI fg
          const colored = arrSorted.map((it, idx) =>
            this.ansiFg(` ¬ ${it.name} — ${this.human(it.p)}/s `, palette[idx % palette.length])
          )
          lines.push('**Brainrot God**')
          lines.push(this.wrapAnsi(colored.join('\n')))
        } else {
          // amarillo para otras rarities
          const yLines = arrSorted.map((it) =>
            this.ansiYellow(` ¬ ${it.name} — ${this.human(it.p)}/s `)
          )
          lines.push(`**${rarity}**`)
          lines.push(this.wrapAnsi(yLines.join('\n')))
        }
      }

      const value = lines.filter(Boolean).join('\n')
      if (value.trim().length) {
        fields.push({ name: `• ${plotName}`, value, inline: false })
      }
    }

    // Footer con JobId
    fields.push({ name: 'Job ID', value: `\`\`\`${jobId}\`\`\``, inline: false })

    // ==== Empaquetar en 1..N embeds y 1..M mensajes (si excede límites) ====
    const baseTitle = `PetNotify${opts?.titleSuffix ?? ''}`
    const color = opts?.forceBlue
      ? PlotStream.COLOR_5M_ONLY
      : opts?.strongBlueHeaderIfHas5m && has5m
        ? PlotStream.COLOR_RAINBOW
        : PlotStream.COLOR_DEFAULT

    const description = [
      `**TOTAL:** ${items.length}`,
      counts.size ? [...summaryPartsToBars(counts)].join(' | ') : null,
    ]
      .filter(Boolean)
      .join('\n')

    function* summaryPartsToBars(map: Map<string, number>) {
      const parts: string[] = []
      if (map.has('Secretos')) parts.push(`Secretos ${map.get('Secretos')}`)
      for (const [k, v] of [...map.entries()]
        .filter(([k]) => k !== 'Secretos')
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
        parts.push(`${k} ${v}`)
      }
      yield* parts
    }

    return this.packEmbeds(baseTitle, description, color, fields)
  }

  // ---- Helpers de empaquetado (split por límites Discord) ----
  private packEmbeds(
    title: string,
    description: string,
    color: number,
    fields: Array<{ name: string; value: string; inline?: boolean }>
  ) {
    const embeds: any[] = []
    let current = this.newEmbed(title, description, color)
    let fieldCount = 0
    let chars = this.embedSize(current)

    for (const f of fields) {
      const chunks = this.chunkFieldValue(f.value, PlotStream.MAX_FIELD_VALUE)
      for (const [i, chunk] of chunks.entries()) {
        const name = i === 0 ? f.name : `${f.name} (cont.)`
        const field = { name, value: chunk, inline: false }
        const addSize = name.length + chunk.length + 10

        const wouldOverflow =
          fieldCount >= PlotStream.MAX_FIELDS_PER_EMBED ||
          chars + addSize > PlotStream.MAX_EMBED_CHARS
        if (wouldOverflow) {
          embeds.push(current)
          current = this.newEmbed(title + ` (cont.)`, description, color)
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

  private newEmbed(title: string, description: string, color: number) {
    return {
      title,
      color,
      description,
      fields: [] as any[],
      footer: { text: `SauPetNotify • ${new Date().toLocaleString()}` },
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
    // Discord: máx 10 embeds por mensaje → fragmentamos
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
      await axios.post(url, payload)
    } catch {}
  }

  // ---- Estilo ANSI ----
  private wrapAnsi(s: string) {
    return '```ansi\n' + s + '\n```'
  }
  private ansiWhiteBold(s: string) {
    return '\u001b[1;97m' + s + '\u001b[0m'
  }
  private ansiYellow(s: string) {
    return '\u001b[33m' + s + '\u001b[0m'
  }
  private ansiFg(s: string, code: number) {
    return `\u001b[${code}m${s}\u001b[0m`
  }
  private ansiBlueWhite(s: string) {
    // Fondo azul fuerte + texto blanco bold
    return '\u001b[44m\u001b[1;97m' + s + '\u001b[0m'
  }

  private human(n: number): string {
    if (n >= 1e12) return `${+(n / 1e12).toFixed(3)}T`
    if (n >= 1e9) return `${+(n / 1e9).toFixed(3)}B`
    if (n >= 1e6) return `${+(n / 1e6).toFixed(3)}M`
    if (n >= 1e3) return `${+(n / 1e3).toFixed(3)}K`
    return `${+n.toFixed(3)}`
  }
}
