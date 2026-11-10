// The Wikipedia tile's rules, run against the file the tile ships (tiles/wikipedia/dist/wiki.js).
import { describe, expect, it } from 'vitest'
import {
  addPlace,
  articleKey,
  cleanPlaces,
  cleanUnit,
  defaultUnit,
  forecastUrl,
  geocodeQuery,
  hitsFrom,
  leadPlace,
  look,
  otherClock,
  pictureFrom,
  placesExit,
  placesFrom,
  randomPastDay,
  removePlace,
  summaryFrom,
  thumb,
  weatherFrom,
  whenFor
  // @ts-expect-error plain JavaScript, as a tile's page is
} from '../tiles/wikipedia/dist/wiki.js'

const lisbon = { name: 'Lisbon', region: 'Lisbon, PT', lat: 38.7167, lon: -9.1333 }
const oslo = { name: 'Oslo', region: 'Oslo, NO', lat: 59.9127, lon: 10.7461 }

describe('wikipedia tile', () => {
  it('cycles today, two from the archive, then today again', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(whenFor)).toEqual(['today', 'past', 'past', 'today', 'past', 'past', 'today'])
  })

  it('picks archive days between 2016 and yesterday', () => {
    const now = new Date(2026, 10, 10, 9)
    expect(randomPastDay(now, () => 0)).toBe('2026-11-09')
    const oldest = randomPastDay(now, () => 0.999999)
    expect(oldest >= '2016-01-01' && oldest < '2016-01-03').toBe(true)
  })

  it('asks only for thumbnail widths Wikimedia serves', () => {
    expect(thumb('//upload.wikimedia.org/a/b/60px-Fox.jpg?x=1', 250)).toBe('https://upload.wikimedia.org/a/b/250px-Fox.jpg')
  })

  it('reads the featured feed, search and summary', () => {
    const feed = { image: { title: 'File:Red fox.jpg', thumbnail: { source: 'https://upload.wikimedia.org/t/640px-Red_fox.jpg' }, description: { text: '<b>A</b> fox' }, artist: { text: '<a>Someone</a>' }, file_page: 'https://commons.wikimedia.org/wiki/File:Red_fox.jpg' } }
    expect(pictureFrom(feed, '2020-01-02', false)).toMatchObject({ title: 'A fox', credit: 'Someone', imageUrl: 'https://upload.wikimedia.org/t/960px-Red_fox.jpg', largeUrl: 'https://upload.wikimedia.org/t/1920px-Red_fox.jpg', date: '2020-01-02', today: false })
    expect(pictureFrom({ image: { ...feed.image, description: {} } }, 'd', true).title).toBe('Red fox')
    expect(pictureFrom({}, 'd', true)).toBeNull()
    const [h] = hitsFrom({ pages: [{ key: 'Red_fox', title: 'Red fox', description: 'Species', excerpt: 'The <span>red</span> fox', thumbnail: { url: '//upload.wikimedia.org/x/60px-F.jpg' } }] })
    expect(h).toEqual({ key: 'Red_fox', title: 'Red fox', description: 'Species', excerpt: 'The red fox', imageUrl: 'https://upload.wikimedia.org/x/250px-F.jpg', url: 'https://en.wikipedia.org/wiki/Red_fox' })
    expect(articleKey('  Red   fox ')).toBe('Red_fox')
    expect(summaryFrom({}, 'Red fox')).toMatchObject({ key: 'Red_fox', title: 'Red fox', url: 'https://en.wikipedia.org/wiki/Red_fox', imageUrl: null })
  })

  it('names WMO weather codes', () => {
    expect(look(0, true)).toEqual({ glyph: '☀︎', label: 'Clear' })
    expect(look(0, false).glyph).toBe('☾︎')
    expect(look(2, true).label).toBe('Partly cloudy')
    expect(look(48, true).label).toBe('Fog')
    expect(look(53, true).label).toBe('Drizzle')
    expect(look(65, true).label).toBe('Heavy rain')
    expect(look(73, true).label).toBe('Snow')
    expect(look(81, true).label).toBe('Showers')
    expect(look(86, true).label).toBe('Snow showers')
    expect(look(99, true).label).toBe('Thunderstorm')
    expect(look(-1, true).label).toBe('')
  })

  it('reads one place or several from the forecast', () => {
    const f = (t: number) => ({ timezone: 'Europe/Lisbon', utc_offset_seconds: 0, current: { temperature_2m: t, apparent_temperature: t - 1.6, weather_code: 3, is_day: 0, wind_speed_10m: 9.4 }, daily: { temperature_2m_max: [t + 2.5], temperature_2m_min: [t - 3] } })
    expect(weatherFrom(f(14.4), [lisbon], 'C')[0]).toEqual({ place: lisbon, unit: 'C', temp: 14, feels: 13, high: 17, low: 11, wind: 9, code: 3, day: false, timezone: 'Europe/Lisbon', utcOffset: 0 })
    const two = weatherFrom([f(1), f(2)], [lisbon, oslo], 'F')
    expect(two.map((r: { temp: number }) => r.temp)).toEqual([1, 2])
    expect(weatherFrom([], [oslo], 'C')[0]).toMatchObject({ temp: null, code: -1, day: true })
    const url = new URL(forecastUrl([lisbon, oslo], 'F'))
    expect(url.host).toBe('api.open-meteo.com')
    expect(url.searchParams.get('latitude')).toBe('38.7167,59.9127')
    expect(url.searchParams.get('temperature_unit')).toBe('fahrenheit')
  })

  it('finds places by name, the part after the comma first', () => {
    expect(geocodeQuery('L')).toBeNull()
    const ask = geocodeQuery('Portland, Oregon')
    expect(new URL(ask.url).searchParams.get('name')).toBe('Portland')
    expect(ask.want).toBe('oregon')
    const results = [
      { name: 'Portland', latitude: 43.66147, longitude: -70.25533, admin1: 'Maine', country_code: 'US' },
      { name: 'Portland', latitude: 45.52345, longitude: -122.67621, admin1: 'Oregon', country_code: 'US' },
      { name: 'Nowhere' }
    ]
    expect(placesFrom({ results }, ask.want)).toEqual([
      { name: 'Portland', region: 'Oregon, US', lat: 45.5234, lon: -122.6762 },
      { name: 'Portland', region: 'Maine, US', lat: 43.6615, lon: -70.2553 }
    ])
  })

  it('keeps places: null is first run, an empty list is a choice', () => {
    expect(cleanPlaces(undefined)).toBeNull()
    expect(cleanPlaces([])).toEqual([])
    expect(cleanPlaces([lisbon, lisbon, { name: 'x', lat: 200, lon: 0 }, { lat: 1, lon: 1 }, 'Oslo'])).toEqual([lisbon])
    let list = addPlace([], lisbon)
    list = addPlace(list, oslo)
    expect(addPlace(list, lisbon)).toBe(list)
    expect(leadPlace(list, oslo)).toEqual([oslo, lisbon])
    expect(removePlace(list, lisbon)).toEqual([oslo])
  })

  it('draws a way out of the places editor only on first run', () => {
    expect(placesExit(null)).toBe('not now')
    expect(placesExit([])).toBeNull()
    expect(placesExit([lisbon])).toBeNull()
  })

  it('picks the unit from the locale unless one was saved', () => {
    expect(defaultUnit('en-US')).toBe('F')
    expect(defaultUnit('en-GB')).toBe('C')
    expect(defaultUnit('pt')).toBe('C')
    expect(cleanUnit('F', 'de-DE')).toBe('F')
    expect(cleanUnit('K', 'de-DE')).toBe('C')
  })

  it('shows another place’s time only when its clock differs', () => {
    expect(otherClock({ timezone: 'Europe/Lisbon', utcOffset: 0 }, 0)).toBe(false)
    expect(otherClock({ timezone: 'Europe/Oslo', utcOffset: 3600 }, 0)).toBe(true)
    expect(otherClock({ timezone: '', utcOffset: 3600 }, 0)).toBe(false)
  })
})
