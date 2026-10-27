const dayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function minutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return (Number(match[1]) * 60) + Number(match[2]);
}

export function isBusinessHours(date = new Date(), options = {}) {
  const timezone = options.timezone || 'America/Sao_Paulo';
  const open = minutes(options.open || '09:00');
  const close = minutes(options.close || '19:00');
  const days = options.days || [1, 2, 3, 4, 5, 6];
  if (open === null || close === null) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const day = dayIndex[parts.weekday];
  const current = (Number(parts.hour) * 60) + Number(parts.minute);
  return days.includes(day) && current >= open && current < close;
}

export function commercialClosingAction({ intent, offer, currentProductId, siteOnly, businessHours }) {
  const closingIntent = ['closing_intent', 'offer_acceptance'].includes(intent);
  if (!closingIntent || !currentProductId) return 'continue';
  if (siteOnly) return 'site_only';
  const priceWasPresented = Boolean(offer?.priceId && offer?.productId === currentProductId);
  if (!priceWasPresented) return 'continue';
  return businessHours ? 'handoff' : 'after_hours_site';
}
