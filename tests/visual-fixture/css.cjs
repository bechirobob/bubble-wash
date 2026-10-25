module.exports=function(source){ return `const s=document.createElement('style');s.textContent=${JSON.stringify(source)};document.head.appendChild(s);`; };
