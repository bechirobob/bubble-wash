import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';
import '../../src/app/globals.css';
import{AdminWorkspace,VendorWorkspace,DriverWorkspace,SupportWorkspace}from'../../src/components/StaffWorkspaces';
import{installFetch}from'./data';
installFetch();
function App(){const[query,setQuery]=useState(location.search);useEffect(()=>{const update=()=>setQuery(location.search);addEventListener('popstate',update);return()=>removeEventListener('popstate',update)},[]);const p=new URLSearchParams(query);const role=p.get('role')||'admin';const common={selectedOrderId:p.get('order')||'',selectedCaseId:p.get('case')||'',selectedActivityId:p.get('activity')||''};return role==='vendor'?<VendorWorkspace {...common} role="vendor" userName="Example laundry partner" initialView={p.get('view')||'jobs'}/>:role==='driver'?<DriverWorkspace {...common} role="driver" userName="Example rider" initialView={p.get('view')||'route'}/>:role==='support'?<SupportWorkspace {...common} role="support" userName="Example support staff" initialView={p.get('view')||'cases'}/>:<AdminWorkspace {...common} role="admin" userName="Example administrator" initialView={p.get('view')||'overview'}/>}
createRoot(document.getElementById('app')!).render(<App/>);
