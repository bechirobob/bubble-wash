// Operator-only synthetic fixtures. Never reads/copies a production database.
import { assertUatEnvironment } from '../src/lib/uat-environment.ts';
import { getDatabase } from '../src/lib/data-store.ts';
import { listVendorAvailability, listDriverAvailability, upsertVendorAvailability, upsertDriverAvailability } from '../src/lib/availability-store.ts';
try {
  assertUatEnvironment();
  if (process.argv.slice(2).join(' ') !== '--approved-synthetic-only') throw new Error();
  const db=getDatabase();
  db.transaction(()=>{
    if(db.prepare('SELECT 1 FROM submissions LIMIT 1').get() || listVendorAvailability().length || listDriverAvailability().length)throw new Error();
    for(const suffix of ['one','two']) {
      upsertVendorAvailability({vendorId:`uat-vendor-${suffix}`,vendorName:`UAT Laundry ${suffix}`,serviceZones:['Osu'],serviceTypes:['Wash + fold'],capacityRemaining:20,availabilityStatus:'available',updatedBy:'approved-synthetic-setup'});
      upsertDriverAvailability({driverId:`uat-driver-${suffix}`,driverName:`UAT Driver ${suffix}`,serviceZones:['Osu'],capacityRemaining:20,availabilityStatus:'active',updatedBy:'approved-synthetic-setup'});
    }
  }).immediate();
  process.stdout.write(JSON.stringify({ok:true,syntheticRoster:true,loginsIssued:false})+'\n');
} catch {process.stderr.write('Synthetic fixture setup refused. Do not overwrite existing data.\n');process.exitCode=1;}
