const {test} = require('node:test');
const assert = require('node:assert/strict');
const core = require('../app/src/main/assets/web/ui-core.js');

test('all 32 exact icon tags resolve to the matching character-pack key', () => {
  const labels = ['대기중','접수','생각중','작업중','주인님?','해냈다','왜안됨','계획대로',
    '안녕','어디보자','잘보세요','찾았다','잠깐','미안해요','좋았어','진짜?',
    '어흐~','우헤헤','븅신','펀치','조금애매함','아닌데?','그건안돼','파일줘봐',
    '검토완료','출처있음','수정완료','ㄹㅇㅋㅋ','정말이지','윙크','하트','잘자'];
  const names = core.chatIconNames();
  assert.equal(labels.length, 32);
  labels.forEach((tag, index) => assert.equal(core.chatIconForTag(tag), names[index], tag));
});

test('semantic tags resolve without interpreting ordinary words as message icons', () => {
  const tags = {질문:'question', 확인:'reviewed', 검색:'inspecting', 완료:'done', 긍정:'happy', 부정:'disagree',
    웃기:'uhehe', 사랑:'heart', 화남:'punch', 당황:'blocked', 잠:'sleep', 미안:'sorry', 요청:'file-request',
    작업중:'working', 자랑:'smug', 오류:'blocked', 응원:'heart', 인사:'greeting', 대기:'idle', 생각:'thinking',
    설명:'explaining', 발견:'discovery', 주의:'caution', 의심:'skeptical', 애매:'uncertain', 근거:'source'};
  for (const [tag, expected] of Object.entries(tags)) assert.equal(core.chatIconForTag(tag), expected, tag);
  for (const tag of ['', '저장됐습니다', '없는태그', '../auth.json', 'toString']) assert.equal(core.chatIconForTag(tag), null);
  assert.equal(core.chatIconForTag('  조 금 애매함  '), 'uncertain');
  assert.equal(core.messageIcon, undefined);
});


test('task activity exposes public tool metadata but never reasoning payloads', () => {
  const reasoning = core.taskActivity('agent.event', {method:'item/started',params:{item:{id:'r',type:'reasoning',text:'private',summary:['private'],encryptedContent:'secret'}}});
  assert.deepEqual(reasoning, {kind:'thinking',key:'',detail:'',output:''});
  assert.deepEqual(core.taskActivity('agent.event', {method:'item/reasoning/summaryTextDelta',params:{delta:'private'}}), reasoning);
  assert.equal(core.taskActivity('agent.event',{method:'unrecognized',params:{text:'private'}}),null);
  assert.equal(core.taskActivity('tool',{name:'mobile_write',path:'app.js'}).kind,'editing');
  assert.equal(core.taskActivity('tool',{name:'mobile_search',path:'.'}).kind,'searching');
  const command = core.taskActivity('agent.event',{method:'item/completed',params:{item:{id:'c',type:'commandExecution',command:'npm test',aggregatedOutput:'failure',exitCode:1}}});
  assert.equal(command.key,'c');assert.equal(command.failed,true);assert.equal(command.completed,true);assert.equal(command.output,'failure');
  const files = core.taskActivity('agent.event',{method:'item/completed',params:{item:{id:'f',type:'fileChange',changes:[{path:'app.js',diff:'+line'}]}}});
  assert.equal(files.kind,'editing');assert.equal(files.detail,'app.js');assert.match(files.output,/\+line/);
  const tool = core.taskActivity('agent.event',{method:'item/completed',params:{item:{id:'t',type:'mcpToolCall',tool:'read',result:{content:[{type:'text',text:'file content'},{type:'image',data:'binary'}]},arguments:{private:'unused'}}}});
  assert.equal(tool.output,'file content');assert.doesNotMatch(JSON.stringify(tool),/binary|unused/);
  const dynamic = core.taskActivity('agent.event',{method:'item/completed',params:{item:{id:'d',type:'dynamicToolCall',tool:'mobile_read',contentItems:[{type:'inputText',text:'read result'}],success:false}}});
  assert.equal(dynamic.kind,'reading');assert.equal(dynamic.output,'read result');assert.equal(dynamic.failed,true);
});
