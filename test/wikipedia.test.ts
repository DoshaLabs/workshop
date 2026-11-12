// The Wikipedia tile's rules, run against the file the tile ships (tiles/wikipedia/dist/wiki.js).
import { describe, expect, it } from 'vitest'
import {
  addPlace,
  articleKey,
  cleanPlaces,
  cleanUnit,
  cropCaption,
  defaultUnit,
  forecastUrl,
  geocodeQuery,
  hitsFrom,
  imageAt,
  pictureFromQuery,
  potdCaptionUrl,
  featuredUrl,
  captionFromWikitext,
  potdUrl,
  sharpUrl,
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
  widthFor
  // @ts-expect-error plain JavaScript, as a tile's page is
} from '../tiles/wikipedia/dist/wiki.js'

const lisbon = { name: 'Lisbon', region: 'Lisbon, PT', lat: 38.7167, lon: -9.1333 }
const oslo = { name: 'Oslo', region: 'Oslo, NO', lat: 59.9127, lon: 10.7461 }

describe('wikipedia tile', () => {
  it('fetches the narrowest served width that fills where the picture is drawn', () => {
    const wide = { width: 8881, height: 5000 }
    // A one-row tile, about 430 × 230 CSS px: cropped to fill, 860 px on a 2x screen.
    expect(widthFor(wide, 430, 230, 2, 'cover')).toBe(960)
    expect(widthFor(wide, 430, 230, 1, 'cover')).toBe(500)
    // A tall picture in a wide tile still fills it across.
    expect(widthFor({ width: 3000, height: 4000 }, 430, 230, 1, 'cover')).toBe(500)
    // The lightbox at 2x is capped at 1920, never more.
    expect(widthFor(wide, 1400, 800, 2, 'contain')).toBe(1920)
    // Fitted whole, a tall picture needs only its height's worth across.
    expect(widthFor({ width: 1000, height: 4000 }, 1400, 800, 1, 'contain')).toBe(250)
    // Unknown shape: 3:2.
    expect(widthFor({}, 300, 300, 1, 'cover')).toBe(500)
  })

  it('serves a picture smaller than the width wanted as its original', () => {
    const p = { thumbSource: 'https://upload.wikimedia.org/t/960px-A.jpg', fullUrl: 'https://upload.wikimedia.org/A.jpg', width: 800, height: 600 }
    expect(imageAt(p, 500)).toBe('https://upload.wikimedia.org/t/500px-A.jpg')
    expect(imageAt(p, 960)).toBe('https://upload.wikimedia.org/A.jpg')
    expect(imageAt({ ...p, width: 0 }, 1920)).toBe('https://upload.wikimedia.org/t/1920px-A.jpg')
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
    expect(pictureFrom(feed, '2020-01-02', false)).toMatchObject({ title: 'A fox', credit: 'Someone', imageUrl: 'https://upload.wikimedia.org/t/960px-Red_fox.jpg', fullUrl: null, date: '2020-01-02', today: false })
    expect(pictureFrom({ image: { ...feed.image, description: {} } }, 'd', true).title).toBe('Red fox')
    const withOriginal = pictureFrom({ image: { ...feed.image, image: { source: 'https://upload.wikimedia.org/Red_fox.jpg?utm_source=x', width: 6000, height: 4000 } } }, 'd', true)
    expect(withOriginal).toMatchObject({ fullUrl: 'https://upload.wikimedia.org/Red_fox.jpg', width: 6000, height: 4000, imageUrl: 'https://upload.wikimedia.org/t/960px-Red_fox.jpg' })
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

describe('the caption under a 9:16 crop', () => {
  it('is the title with its credit, and the day as mm/dd/yy', () => {
    expect(cropCaption({ date: '2026-11-12', title: 'Grey heron at dawn', credit: 'Jane Doe' })).toEqual({
      text: 'Grey heron at dawn. Jane Doe',
      source: 'Wikipedia Photo of the Day, 11/12/26'
    })
    expect(cropCaption({ date: '2025-01-05', title: 'Ice', credit: '' }).text).toBe('Ice')
    expect(cropCaption({ date: '2025-01-05', title: 'Ice' }).source).toBe('Wikipedia Photo of the Day, 01/05/25')
  })
})

describe('the lightbox picture', () => {
  const pic = (width: number, height: number) => ({
    width,
    height,
    thumbSource: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/960px-X.jpg',
    fullUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg'
  })
  it('is one served width down from the original', () => {
    expect(sharpUrl(pic(6231, 4154))).toMatch(/\/3840px-X\.jpg$/)
    expect(sharpUrl(pic(2400, 1600))).toMatch(/\/1920px-X\.jpg$/)
    expect(sharpUrl(pic(3000, 4500))).toMatch(/\/1920px-X\.jpg$/)
  })
  it('is the original when that step is under 1080 on its short side', () => {
    expect(sharpUrl(pic(1800, 1200))).toBe(pic(1, 1).fullUrl)
    expect(sharpUrl(pic(5000, 1200))).toBe(pic(1, 1).fullUrl)
    expect(sharpUrl(pic(1200, 1800))).toBe(pic(1, 1).fullUrl)
    expect(sharpUrl(pic(200, 150))).toBe(pic(1, 1).fullUrl)
  })
  it('is 1920 when the size is unknown', () => {
    expect(sharpUrl({ ...pic(0, 0) })).toMatch(/\/1920px-X\.jpg$/)
  })
})

describe('a day\'s picture from its template', () => {
  const ii = (title: string, width: number, height: number) => ({
    title,
    imageinfo: [
      {
        width,
        height,
        url: `https://upload.wikimedia.org/wikipedia/commons/9/90/${title.slice(5)}`,
        thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/9/90/${title.slice(5)}/960px-${title.slice(5)}`,
        descriptionurl: `https://commons.wikimedia.org/wiki/${title}`,
        extmetadata: { ImageDescription: { value: 'Soft-plumaged <i>petrel</i>' }, Artist: { value: '<a href="//x">JJ Harrison</a>' } }
      }
    ]
  })
  it('asks the API for the template\'s files, with CORS', () => {
    const u = new URL(potdUrl('2023-08-09'))
    expect(u.host).toBe('commons.wikimedia.org')
    expect(u.searchParams.get('titles')).toBe('Template:Potd/2023-08-09')
    expect(u.searchParams.get('origin')).toBe('*')
  })
  it('takes the largest file, as the feed\'s picture would be', () => {
    const p = pictureFromQuery({ query: { pages: [ii('File:Icon.png', 40, 40), ii('File:Petrel.jpg', 4525, 3017)] } }, '2023-08-09', false)!
    expect(p).toMatchObject({ date: '2023-08-09', today: false, title: 'Soft-plumaged petrel', credit: 'JJ Harrison', width: 4525, height: 3017 })
    expect(p.url).toBe('https://commons.wikimedia.org/wiki/File:Petrel.jpg')
    expect(p.imageUrl).toMatch(/\/960px-Petrel\.jpg$/)
  })
  it('is null for a day with no picture', () => {
    expect(pictureFromQuery({ batchcomplete: true }, '2001-01-01', false)).toBeNull()
  })
})

describe('the day\'s caption from Commons', () => {
  it('is the first parameter as plain text, links as their labels', () => {
    expect(
      captionFromWikitext(
        '{{Potd description|1=[[:en:Czechoslovak koruna|50 Korun]] banknote of [[Československo / Česko-Slovensko|Czechoslovakia]], issued in 1929 by the [[:en:National Bank of Czechoslovakia|National Bank of Czechoslovakia]] |2=en|3=2026|4=11|5=12}}'
      )
    ).toBe('50 Korun banknote of Czechoslovakia, issued in 1929 by the National Bank of Czechoslovakia')
    expect(captionFromWikitext("{{Potd description|1=''[[:en:Josephine Baker|Joséphine Baker]]'', lithography, 1931.|2=en}}")).toBe('Joséphine Baker, lithography, 1931.')
    expect(captionFromWikitext('{{Potd description|1=[[:Category:Acropolis of Athens|Acropolis]] panorama, [[:en:Athens]].|2=en}}')).toBe('Acropolis panorama, Athens.')
  })
  it('drops inner templates and keeps going past their pipes', () => {
    expect(captionFromWikitext('{{Potd description|1=A {{w|heron|grey heron}} at dawn|2=en}}')).toBe('A at dawn')
  })
  it('is empty when there is nothing to read', () => {
    expect(captionFromWikitext(undefined)).toBe('')
    expect(captionFromWikitext('no template here')).toBe('')
  })
})

describe('the page lets the tile fetch what it asks for', () => {
  it('has every host the tile fetches from in its connect-src', async () => {
    const { readFileSync } = await import('node:fs')
    const html = readFileSync(new URL('../tiles/wikipedia/dist/index.html', import.meta.url), 'utf8')
    const connect = /connect-src ([^;"]+)/.exec(html)![1].split(/\s+/)
    const pic = { width: 6000, height: 4000, thumbSource: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/960px-X.jpg', fullUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg' }
    const fetched = [potdUrl('2023-08-09'), potdCaptionUrl('2023-08-09'), featuredUrl('2023-08-09'), sharpUrl(pic), sharpUrl({ ...pic, width: 1500, height: 1000 }), 'https://thumb.wikimedia.org/x']
    for (const u of fetched) expect(connect, u).toContain(new URL(u).origin)
  })
})
