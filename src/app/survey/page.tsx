import Link from 'next/link';
import {BrandLink} from '@/components/BrandLink';
import {researchEmailReady} from '@/lib/research/provider';
import {collectionOpen} from '@/lib/research/policy';
import {forms} from '@/lib/research/model';
export const dynamic='force-dynamic';
export const metadata={title:'Research | Bubble Wash',robots:{index:false,follow:false}};
export default function Survey(){
 const open=collectionOpen()&&researchEmailReady();
 return <main style={{maxWidth:680,margin:'40px auto',padding:24,fontFamily:'system-ui,sans-serif'}}><BrandLink/><p>Bubblewash Research</p><h1>{open?'Questionnaires':'This survey is not accepting responses.'}</h1>{open?<><p>Choose the relevant questionnaire. This interim version includes confirmed questions; some questions will be added later. No account is needed.</p><ul>{forms.map(form=><li key={form.id} style={{margin:'24px 0'}}><Link href={'/survey/'+form.id}>{form.title}</Link></li>)}</ul></>:<p>No new responses can be submitted.</p>}<Link href="/">Back to Bubble Wash</Link></main>;
}

