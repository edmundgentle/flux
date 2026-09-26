const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../utils/contactUtils.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const contactUtils = {};
new Function('require', 'exports', compiled)(() => ({ Linking: {} }), contactUtils);
const { generateVCard, getContactFileName, parseContactVCard } = contactUtils;

test('filenames use the contact name and full identity to avoid same-name clashes', () => {
  const first = { id: 'contact_one', firstName: 'Jane', surname: 'Doe' };
  const second = { ...first, id: 'contact_two' };
  assert.equal(getContactFileName(first), 'jane-doe-contact_one.vcf');
  assert.equal(getContactFileName(second), 'jane-doe-contact_two.vcf');
  assert.equal(getContactFileName({ ...first, firstName: 'Janet' }), 'janet-doe-contact_one.vcf');
  assert.equal(getContactFileName({ id: 'id/1', firstName: 'Zoë', surname: 'A/B' }), 'zoë-a-b-id%2f%1.vcf');
  assert.equal(getContactFileName({ id: 'id%2f%1', firstName: 'Zoë', surname: 'A/B' }), 'zoë-a-b-id%25%2f%25%1.vcf');
});

test('vCard file round-trips contact data and escaped text', () => {
  const contact = {
    id: 'contact_123', path: 'Contacts/contact_123.vcf',
    firstName: 'Jo;an', middleName: 'A', surname: 'Smith, Jr', lastName: 'Smith, Jr',
    displayName: 'Jo;an A Smith, Jr', company: 'A\\B', jobTitle: 'Lead',
    phones: [{ id: 'phone_1', label: 'Work', number: '+1 555 0100' }],
    emails: [{ id: 'email_1', label: 'Personal', email: 'jo@example.com' }],
    socialProfiles: [{ id: 'social_1', platform: 'GitHub', username: 'jo', url: 'https://github.com/jo' }],
    addresses: [{ id: 'address_1', label: 'Home', street: '123 Main; Apt 2', city: 'New York', state: 'NY', zip: '10001', country: 'US' }],
    notes: `First line\nSecond, line; with \\ slash ${'é'.repeat(50)}`, birthday: '2000-01-02',
    tags: ['friends, family', 'work'], favorite: true, avatarUrl: 'https://example.com/avatar.png',
    createdAt: 1700000000000, updatedAt: 1700000001000,
  };

  const serialized = generateVCard(contact);
  assert.match(serialized, /^BEGIN:VCARD\r\nVERSION:3.0\r\n/);
  assert.match(serialized, /N:Smith\\, Jr;Jo\\;an;A;;/);
  assert.ok(serialized.split('\r\n').every((line) => Buffer.byteLength(line, 'utf8') <= 75));
  assert.match(serialized, /\r\n /);
  const parsed = parseContactVCard(serialized, '/data/user/Contacts/contact_123.vcf', 0);
  assert.deepEqual(parsed, { ...contact, path: '/data/user/Contacts/contact_123.vcf' });
});

test('external vCards without Flux fields use filename identity', () => {
  const external = parseContactVCard('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Jane Doe\r\nTEL;TYPE=HOME:123\r\nEND:VCARD', '/data/user/Contacts/jane.vcf', 42);
  assert.equal(external.id, 'jane');
  assert.equal(external.displayName, 'Jane Doe');
  assert.equal(external.phones[0].label, 'Home');
  assert.throws(() => parseContactVCard('not a vcard', 'bad.vcf', 42));
});