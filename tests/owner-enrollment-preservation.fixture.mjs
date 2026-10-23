import { inviteOwnerAccount } from '../src/lib/staff-accounts.ts';
try {
  inviteOwnerAccount({ email: 'new-owner@example.invalid', name: 'Synthetic Owner' }, 'synthetic-actor');
  console.log('ENROLLED');
} catch {
  console.log('REJECTED');
}
