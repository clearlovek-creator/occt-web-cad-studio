/** Bounded human-message specimen; never a replacement for native history or its byte digest. */
export function createPiHistoryPreview(){
  const messages=[];let decoder,line='',dropping=false,lines=0,skippedLines=0,omittedMessages=0,limited=false;
  const accept=()=>{
    if(dropping){skippedLines++;dropping=false;line='';return;}
    if(!line.trim()){line='';return;}
    if(lines++>=10000){limited=true;line='';return;}
    let entry;try{entry=JSON.parse(line);}catch{skippedLines++;line='';return;}line='';
    const message=entry?.type==='message'?entry.message:null;
    if(!message||!['user','assistant'].includes(message.role))return;
    let text='';if(typeof message.content==='string')text=message.content;else if(Array.isArray(message.content))for(const part of message.content){if(part?.type==='text'&&typeof part.text==='string'){text+=(text?'\n':'')+part.text;if(text.length>1000)break;}}
    if(!text.trim())return;const truncated=text.length>1000;
    messages.push({role:message.role,text:text.slice(0,1000),...(typeof entry.timestamp==='string'&&entry.timestamp.length<=100&&Number.isFinite(Date.parse(entry.timestamp))?{timestamp:entry.timestamp}:{}),truncated});
    if(messages.length>12){messages.shift();omittedMessages++;}
  };
  const consume=value=>{
    let at=0;while(at<value.length){if(lines>=10000){limited=true;return;}const end=value.indexOf('\n',at),part=value.slice(at,end<0?value.length:end);
      if(!dropping){if(line.length+part.length>65536){line='';dropping=true;limited=true;}else line+=part;}
      if(end<0)break;accept();at=end+1;
    }
  };
  return {startFile(){decoder=new TextDecoder('utf-8');line='';dropping=false;},push(bytes){if(lines<10000)consume(decoder.decode(bytes,{stream:true}));else limited=true;},endFile(){if(lines<10000){consume(decoder.decode());if(line||dropping)accept();}line='';dropping=false;},result(){return {version:1,messages:messages.map(value=>({...value})),omittedMessages,skippedLines,limited};}};
}
