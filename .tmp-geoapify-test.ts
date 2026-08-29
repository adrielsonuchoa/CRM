import { discoverGeoapifyPlaces } from './src/lib/prospecting-sources.ts';

const cfg = {
  city: 'Maceio',
  prospectingCities: '["Maceio"]',
  prospectingSegments: '["restaurante"]',
  prospectingSearchTerms: '["restaurante maceio"]',
  maxProfilesPerRun: 3,
};

const result = await discoverGeoapifyPlaces(cfg);
console.log(JSON.stringify({
  found: result.found,
  leadIds: result.leadIds.length,
  created: result.created,
  duplicates: result.duplicates,
  errors: result.errors,
}, null, 2));
