(function(){
  'use strict';
  const list=document.getElementById('terminals'),status=document.getElementById('status'),reload=document.getElementById('reload'),dialog=document.getElementById('revoke-dialog');
  if (!list || !window.AppAuth?.isAdmin?.()) return;
  let selected=null;
  const date=value=>value?new Date(value).toLocaleString('ru-RU'):'Ещё не подключался';
  async function request(path,method='GET',body){
    const res=await fetch(window.AppAuth?.getApiUrl?.('/api/loader/terminals'+path)||'/api/loader/terminals'+path,{method,credentials:'same-origin',headers:{...(window.AppAuth?.getAuthHeaders?.()||{}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,cache:'no-store'});
    const data=await res.json();if(!res.ok)throw Error(data.error||'Ошибка сервера');return data;
  }
  function text(tag,value,parent){const node=document.createElement(tag);node.textContent=value;parent.appendChild(node);return node;}
  async function load(){
    reload.disabled=true;status.textContent='Загрузка…';
    try{
      const data=await request('');list.textContent='';
      data.terminals.forEach(t=>{
        const card=document.createElement('article');card.className='terminal';list.appendChild(card);const info=document.createElement('div');card.appendChild(info);
        text('h2',t.name,info);const badge=text('span',t.revokedAt?'Доступ отозван':'Зарегистрирован',info);badge.className='badge '+(t.revokedAt?'badge-secondary':'badge-success');
        text('p','Хозяин: '+t.deviceId,info);text('p','Регистрация: '+date(t.createdAt),info);text('p','Последняя связь: '+date(t.lastSeenAt),info);
        if(!t.revokedAt){
          const remote=text('div','',info),details=text('p','Проверяем управление…',remote);
          const shot=text('button','Снимок экрана',remote),update=text('button','Обновить приложение',remote);
          const img=document.createElement('img');img.style.cssText='max-width:100%;display:none;margin-top:16px';img.alt='Последний снимок экрана ВИ-КОРМ';remote.appendChild(img);
          shot.className='btn btn-primary btn-sm mr-2 mb-2';update.className='btn btn-outline-primary btn-sm mb-2';
          let objectUrl=null;
          async function refresh(){
            if(!card.isConnected){if(objectUrl)URL.revokeObjectURL(objectUrl);return;}
            try { const state=await request('/'+t.id+'/remote');
              details.textContent=(state.version?'Версия '+state.version+' · ':'')+'Связь: '+date(state.lastSeenAt)+(state.busy?' · Идёт задание':'')+(state.command?' · '+({pending:'Команда ожидает связи',waiting:'Ожидает завершения задания',installing:'Установка',done:'Выполнено',failed:'Ошибка',expired:'Срок команды истёк'}[state.command.status]||state.command.status)+(state.command.message?' · '+state.command.message:''):'');
              if(state.hasScreenshot && img.dataset.at!==String(state.capturedAt)){
                const response=await fetch('/api/loader/terminals/'+t.id+'/screenshot',{headers:window.AppAuth.getAuthHeaders(),cache:'no-store'});
                if(response.ok){if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(await response.blob());img.src=objectUrl;img.style.display='block';img.dataset.at=state.capturedAt;img.title=date(state.capturedAt)}
              }
            }catch(e){details.textContent=e.message}
            if(card.isConnected)setTimeout(refresh,5000);else if(objectUrl)URL.revokeObjectURL(objectUrl);
          }
          async function command(type){try{await request('/'+t.id+'/remote','POST',{type});details.textContent='Команда отправлена. Планшет проверяет команды каждые 10 секунд.'}catch(e){details.textContent=e.message}}
          shot.onclick=()=>command('screenshot');
          let confirmUntil=0;
          update.onclick=()=>{
            if(Date.now()>confirmUntil){confirmUntil=Date.now()+10000;update.textContent='Подтвердить обновление';setTimeout(()=>{update.textContent='Обновить приложение'},10000);return}
            confirmUntil=0;update.textContent='Обновить приложение';command('update');
          };refresh();
        }
        if(t.revokedAt)text('p','Отключён: '+date(t.revokedAt),info);
        else {const button=text('button','Отозвать доступ',card);button.className='btn btn-outline-danger btn-sm';button.addEventListener('click',()=>{selected=t.id;dialog.returnValue='';document.getElementById('revoke-name').textContent=t.name+' · '+t.deviceId;dialog.showModal();});}
      });
      status.textContent=data.terminals.length?'Терминалов: '+data.terminals.length:'Зарегистрированных планшетов пока нет';
    }catch(e){status.textContent=e.message;}finally{reload.disabled=false;}
  }
  dialog.addEventListener('close',async()=>{if(dialog.returnValue!=='revoke'||!selected)return;const id=selected;selected=null;reload.disabled=true;try{await request('/'+encodeURIComponent(id)+'/revoke','POST');await load();}catch(e){status.textContent=e.message;reload.disabled=false;}});
  reload.addEventListener('click',load);
  if (location.hash === '#adminTerminalsPanel') window.jQuery('#adminTerminalsTab').tab('show');
  load();
}());
