// Secondary fixtures remain for explicit admin onboarding/negative tests, not automatic dispatch.
// Narrow pre-issuance fixture correction; not a general roster-edit operator.
import { assertUatEnvironment } from 'file:///opt/bubblewash-uat/app/src/lib/uat-environment.ts';
import { getDatabase } from 'file:///opt/bubblewash-uat/app/src/lib/data-store.ts';
import { listVendorAvailability, listDriverAvailability, upsertVendorAvailability, upsertDriverAvailability } from 'file:///opt/bubblewash-uat/app/src/lib/availability-store.ts';
try {
  assertUatEnvironment();
  const db=getDatabase();
  db.transaction(()=>{
    if(db.prepare('SELECT 1 FROM submissions LIMIT 1').get())throw new Error();
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='staff_uat_accounts'").get() && db.prepare('SELECT 1 FROM staff_uat_accounts LIMIT 1').get())throw new Error();
    const vendors=listVendorAvailability(),drivers=listDriverAvailability();
    if(vendors.length!==2 || drivers.length!==2)throw new Error();
    for(const suffix of ['one','two']){
      const vendor=vendors.find(v=>v.vendorId==='uat-vendor-'+suffix),driver=drivers.find(d=>d.driverId==='uat-driver-'+suffix);
      if(!vendor || !driver || vendor.vendorName!=='UAT Laundry '+suffix || driver.driverName!=='UAT Driver '+suffix || vendor.capacityRemaining!==20 || driver.capacityRemaining!==20 || vendor.availabilityStatus!=='available' || driver.availabilityStatus!=='active' || JSON.stringify(vendor.serviceZones)!=='["Osu"]' || JSON.stringify(driver.serviceZones)!=='["Osu"]' || JSON.stringify(vendor.serviceTypes)!=='["Wash + fold"]')throw new Error();
    }
    upsertVendorAvailability({...vendors.find(v=>v.vendorId==='uat-vendor-two'),availabilityStatus:'paused',updatedBy:'approved-uat-fixture-isolation'});
    upsertDriverAvailability({...drivers.find(d=>d.driverId==='uat-driver-two'),availabilityStatus:'inactive',updatedBy:'approved-uat-fixture-isolation'});
  }).immediate();
  process.stdout.write('{"ok":true,"syntheticPriorityCorrected":true,"accountsIssued":false}\n');
}catch{process.stderr.write('Synthetic fixture priority correction refused.\n');process.exitCode=1;}
