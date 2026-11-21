/** Provisional native successes are not committed successes after rollback. */
export function failedBatchResults(steps, provisional, failure) {
  return steps.map((step,index)=>{
    const attempted=provisional[index];
    const status=attempted?.ok?"rolled-back":attempted?"failed":"not-executed";
    return {ok:false,operation:step.operation,requestId:step.fields?.requestId || null,status,
      code:failure.code || "BATCH_ROLLED_BACK",causeCode:attempted?.code || failure.causeCode || null,
      error:status==="rolled-back"?"该步骤已随整批事务回滚，没有提交几何。":status==="not-executed"?"前序步骤失败，该步骤未执行。":attempted?.error || failure.error,
      ...(Number.isSafeInteger(failure.revision)?{revision:failure.revision}:{}),
      transaction:{state:status==="not-executed"?"not-executed":"rolled-back"}};
  });
}
