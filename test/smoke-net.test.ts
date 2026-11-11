import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript, as a tile's page is
import { featuredUrl, forecastUrl, geocodeQuery, hitsFrom, pictureFrom, placesFrom, searchUrl, summaryFrom, summaryUrl, weatherFrom } from '../tiles/wikipedia/dist/wiki.js'
import { cannedAnswer, testPattern } from '../src/main/smoke-net'

const get = (url: string): any => {
  const a = cannedAnswer(new URL(url))
  if (!a) throw new Error(`no answer for ${url}`)
  return typeof a.body === 'string' ? JSON.parse(a.body) : a.body
}

describe('the smoke run’s stand-in for Wikipedia and Open-Meteo', () => {
  it('answers what the tile asks, in shapes the tile’s own rules read', () => {
    const pic = pictureFrom(get(featuredUrl('2026-11-11')), '2026-11-11', true)
    expect(pic?.title).toContain('2026-11-11')
    expect(cannedAnswer(new URL(pic!.imageUrl))?.type).toBe('image/png')
    expect(summaryFrom(get(summaryUrl('Red fox')), 'Red fox').title).toBe('Red fox')
    expect(get('https://en.wikipedia.org/api/rest_v1/page/summary/Fox').title).toBe('Fox')
    const hits = hitsFrom(get(searchUrl('red fox')))
    expect(hits[0].title).toBe('Red fox')
    expect(cannedAnswer(new URL(hits[0].imageUrl))?.type).toBe('image/png')
    const q = geocodeQuery('Lisbon, Portugal')!
    const places = placesFrom(get(q.url), q.want)
    expect(places[0]).toMatchObject({ name: 'Lisbon', region: 'Lisbon, PT' })
    const one = weatherFrom(get(forecastUrl(places.slice(0, 1), 'C')), places.slice(0, 1), 'C')
    const two = weatherFrom(get(forecastUrl(places.slice(0, 2), 'C')), places.slice(0, 2), 'C')
    expect(one[0].temp).toBe(18)
    expect(two.map((r: { high: number }) => r.high)).toEqual([21, 22])
  })

  it('answers nothing else', () => {
    expect(cannedAnswer(new URL('https://en.wikipedia.org/wiki/Fox'))).toBeNull()
    expect(cannedAnswer(new URL('https://example.com/'))).toBeNull()
  })

  it('serves a real PNG', () => {
    const png = testPattern(8, 4)
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(8)
    expect(png.readUInt32BE(20)).toBe(4)
  })
})
