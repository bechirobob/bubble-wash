import Link from 'next/link';
import {notFound} from 'next/navigation';
import {findForm} from '@/lib/research/model';
import {researchEmailReady} from '@/lib/research/provider';
import {collectionOpen} from '@/lib/research/policy';
import {ResearchForm} from '@/components/research/ResearchForm';
export const dynamic='force-dynamic';
export const metadata={robots:{index:false,follow:false}};
export default async function Questionnaire({params}:{params:Promise<{instrument:string}>}){
 const form=findForm((await params).instrument);if(!form)notFound();
 if(!collectionOpen()||!researchEmailReady())return <main style={{maxWidth:640,margin:'64px auto',padding:24}}><h1>This survey is closed.</h1><p>No new response can be submitted.</p><Link href="/survey">Back to research</Link></main>;
 return <ResearchForm instrumentId={form.id}/>;
}

