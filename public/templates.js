// Post templates — the single source of truth for the channel's format.
// The browser imports this for the live preview and the server imports it
// to build the final caption, so what you preview is exactly what posts.
//
// WhatsApp formatting: *bold*  _italic_  ~strike~  ```mono```

export const TEMPLATES = {
  breaking: {
    label: '🚨 Breaking News',
    fields: [
      { key: 'headline', label: 'Headline', placeholder: 'LeBron James signs 2-year extension with Lakers' },
      { key: 'details', label: 'Details', type: 'textarea', placeholder: 'Per @ShamsCharania, the deal is worth $104M…' },
      { key: 'source', label: 'Source (optional)', placeholder: 'Shams Charania' },
    ],
    build: (f) => [
      '🚨 *BREAKING* 🚨\n',
      `*${f.headline}*`,
      f.details && `\n${f.details}`,
      f.source && `\n📰 _via ${f.source}_`,
    ],
  },

  final: {
    label: '🏀 Final Score',
    fields: [
      { key: 'away', label: 'Away team', placeholder: 'Celtics' },
      { key: 'awayScore', label: 'Away score', placeholder: '112' },
      { key: 'home', label: 'Home team', placeholder: 'Knicks' },
      { key: 'homeScore', label: 'Home score', placeholder: '108' },
      { key: 'star', label: 'Top performer (optional)', placeholder: 'Jayson Tatum: 38 PTS · 11 REB · 6 AST' },
      { key: 'notes', label: 'Notes (optional)', type: 'textarea', placeholder: 'Boston wins 5th straight' },
    ],
    build: (f) => [
      '🏀 *FINAL*\n',
      `${f.away} *${f.awayScore}*`,
      `${f.home} *${f.homeScore}*`,
      f.star && `\n⭐ ${f.star}`,
      f.notes && `\n${f.notes}`,
    ],
  },

  trade: {
    label: '🔄 Trade Alert',
    fields: [
      { key: 'headline', label: 'Headline', placeholder: 'Suns trade Bradley Beal to the Heat' },
      { key: 'teamA', label: 'Team A', placeholder: 'Suns' },
      { key: 'getsA', label: 'Team A receives', type: 'textarea', placeholder: 'Duncan Robinson\n2027 1st-round pick' },
      { key: 'teamB', label: 'Team B', placeholder: 'Heat' },
      { key: 'getsB', label: 'Team B receives', type: 'textarea', placeholder: 'Bradley Beal' },
      { key: 'source', label: 'Source (optional)', placeholder: 'Adrian Wojnarowski' },
    ],
    build: (f) => [
      '🔄 *TRADE ALERT* 🔄\n',
      `*${f.headline}*`,
      f.teamA && f.getsA && `\n*${f.teamA} receive:*\n${bullets(f.getsA)}`,
      f.teamB && f.getsB && `\n*${f.teamB} receive:*\n${bullets(f.getsB)}`,
      f.source && `\n📰 _via ${f.source}_`,
    ],
  },

  injury: {
    label: '🏥 Injury Update',
    fields: [
      { key: 'player', label: 'Player', placeholder: 'Joel Embiid' },
      { key: 'team', label: 'Team', placeholder: '76ers' },
      { key: 'status', label: 'Status', placeholder: 'OUT' },
      { key: 'injury', label: 'Injury', placeholder: 'Left knee soreness' },
      { key: 'details', label: 'Details (optional)', type: 'textarea', placeholder: 'Expected to be re-evaluated in 1-2 weeks' },
    ],
    build: (f) => [
      '🏥 *INJURY UPDATE*\n',
      `*${f.player}*${f.team ? ` (${f.team})` : ''}`,
      `Status: *${(f.status || '').toUpperCase()}*`,
      f.injury && `Injury: ${f.injury}`,
      f.details && `\n${f.details}`,
    ],
  },

  stats: {
    label: '📊 Stat Line',
    fields: [
      { key: 'player', label: 'Player', placeholder: 'Nikola Jokić' },
      { key: 'line', label: 'Stat line', placeholder: '31 PTS · 17 REB · 12 AST' },
      { key: 'context', label: 'Context (optional)', type: 'textarea', placeholder: 'His 8th triple-double of the season' },
    ],
    build: (f) => [
      '📊 *STAT LINE*\n',
      `*${f.player}*`,
      `🔥 ${f.line}`,
      f.context && `\n${f.context}`,
    ],
  },

  custom: {
    label: '✍️ Custom',
    fields: [
      { key: 'title', label: 'Title (optional, shown bold)', placeholder: 'GAME DAY' },
      { key: 'body', label: 'Text', type: 'textarea', placeholder: 'Write anything…' },
    ],
    build: (f) => [f.title && `*${f.title}*\n`, f.body],
  },
};

// Required = every field whose label doesn't say "(optional)".
export function missingFields(templateId, fields = {}) {
  const t = TEMPLATES[templateId];
  if (!t) return ['template'];
  return t.fields
    .filter((d) => !/optional/i.test(d.label) && !String(fields[d.key] ?? '').trim())
    .map((d) => d.label);
}

export function buildCaption(templateId, fields = {}, { footer = '' } = {}) {
  const t = TEMPLATES[templateId];
  if (!t) throw new Error(`Unknown template "${templateId}"`);
  const clean = Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, String(v ?? '').trim()]),
  );
  const lines = t.build(clean).filter(Boolean); // drops empty optional fields
  let text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (footer.trim()) text += `\n\n${footer.trim()}`;
  return text;
}

function bullets(text) {
  return text
    .split('\n')
    .map((l) => l.trim().replace(/^[-•*]\s*/, ''))
    .filter(Boolean)
    .map((l) => `• ${l}`)
    .join('\n');
}
