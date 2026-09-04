(function(){
  'use strict';
  const list=document.getElementById('terminals'),status=document.getElementById('status'),reload=document.getElementById('reload'),dialog=document.getElementById('revoke-dialog');
  let selected=null;
  const date=value=>value?new Date(value).toLocaleString('ru-RU'):'Ещё не подключался';
  async function request(path,method='GET'){
    const res=await fetch(window.AppAuth?.getApiUrl?.('/api/loader/terminals'+path)||'/api/loader/terminals'+path,{method,credentials:'same-origin',headers:window.AppAuth?.getAuthHeaders?.()||{},cache:'no-store'});
    const data=await res.json();if(!res.ok)throw Error(data.error||'Ошибка сервера');return data;
  }
  function text(tag,value,parent){const node=document.createElement(tag);node.textContent=value;parent.appendChild(node);return node;}
  async function load(){
    reload.disabled=true;status.textContent='Загрузка…';
    try{
      const data=await request('');list.textContent='';
      data.terminals.forEach(t=>{
        const card=document.createElement('article');card.className='terminal';list.appendChild(card);const info=document.createElement('div');card.appendChild(info);
        text('h2',t.name,info);const badge=text('span',t.revokedAt?'Доступ отозван':'Зарегистрирован',info);badge.className='badge'+(t.revokedAt?' revoked':'');
        text('p','Хозяин: '+t.deviceId,info);text('p','Регистрация: '+date(t.createdAt),info);text('p','Последняя связь: '+date(t.lastSeenAt),info);
        if(t.revokedAt)text('p','Отключён: '+date(t.revokedAt),info);
        else {const button=text('button','Отозвать доступ',card);button.className='danger';button.addEventListener('click',()=>{selected=t.id;dialog.returnValue='';document.getElementById('revoke-name').textContent=t.name+' · '+t.deviceId;dialog.showModal();});}
      });
      status.textContent=data.terminals.length?'Терминалов: '+data.terminals.length:'Зарегистрированных планшетов пока нет';
    }catch(e){status.textContent=e.message;}finally{reload.disabled=false;}
  }
  dialog.addEventListener('close',async()=>{if(dialog.returnValue!=='revoke'||!selected)return;const id=selected;selected=null;reload.disabled=true;try{await request('/'+encodeURIComponent(id)+'/revoke','POST');await load();}catch(e){status.textContent=e.message;reload.disabled=false;}});
  reload.addEventListener('click',load);load();
}());
