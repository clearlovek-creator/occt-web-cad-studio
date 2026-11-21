/** Byte-bounded JSON-line framing without repeatedly copying a growing partial line. */
export class BoundedJsonLines{
  constructor(maxBytes){if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw Error('Invalid frame budget');this.maxBytes=maxBytes;this.clear();}
  clear(){this.parts=[];this.bytes=0;this.tail=null;this.used=0;}
  append(part){
    if(this.bytes+part.length>this.maxBytes)throw Object.assign(Error('JSON line exceeds byte budget'),{code:'MCP_FRAME_LIMIT'});
    let offset=0;while(offset<part.length){if(!this.tail||this.used===this.tail.length){this.tail=Buffer.allocUnsafe(Math.min(65536,this.maxBytes-this.bytes));this.used=0;this.parts.push(this.tail);}const count=Math.min(part.length-offset,this.tail.length-this.used);part.copy(this.tail,this.used,offset,offset+count);this.used+=count;this.bytes+=count;offset+=count;}
  }
  line(){const parts=this.parts.map((part,index)=>index===this.parts.length-1?part.subarray(0,this.used):part),bytes=Buffer.concat(parts,this.bytes);this.clear();const value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);return value.endsWith('\r')?value.slice(0,-1):value;}
  push(value,onLine){const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);let start=0;for(;;){const end=chunk.indexOf(10,start);if(end<0){this.append(chunk.subarray(start));return;}this.append(chunk.subarray(start,end));if(onLine(this.line())===false){this.clear();return;}start=end+1;}}
  finish(onLine){if(this.bytes)onLine(this.line());}
}
