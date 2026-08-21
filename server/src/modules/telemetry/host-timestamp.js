export const ISO_DATE_TIME_WITHOUT_ZONE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/

export function parseHostTimestamp(value, fallback = new Date()) {
  if (value === undefined || value === null || value === '') {
    return new Date(fallback)
  }

  if (typeof value === 'string') {
    const timestamp = value.trim()
    // The HOST device reports UTC, but older firmware omits the trailing `Z`.
    // Make that wire-format contract explicit instead of letting Node interpret
    // a zone-less date-time in the server's local timezone.
    return new Date(ISO_DATE_TIME_WITHOUT_ZONE.test(timestamp) ? `${timestamp}Z` : timestamp)
  }

  return new Date(value)
}
