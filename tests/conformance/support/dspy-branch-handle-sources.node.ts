// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export function branchHandleSources(helper: boolean): Record<string, string> {
  return {
    'selected.py': `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0
import asyncio
import uuid
import dspy
from galaxie._bridge import notify_stream_data
from galaxie.dspy import Executor, GalaxieLM, branches, request_interaction

uuid.uuid4 = lambda: uuid.UUID('55de87eb-28d7-466f-9222-de0713ae5d68')

class Program(dspy.Module):
    def __init__(self):
        super().__init__()
        self.predict = dspy.Predict('question: str -> answer: str')
        self.predict.set_lm(GalaxieLM('answer'))

    async def aforward(self, question):
        async def branch(label):
            lock = asyncio.Lock()
            async def call(phase):
                async with lock:
                    return (await self.predict.acall(question=f'{label}:{phase}')).answer
            async def inner():
                return [await call('before'), await call('last-before')]
            if ${helper ? 'True' : 'False'}:
                return await asyncio.create_task(inner())
            return await asyncio.gather(call('before'), call('last-before'))
        answers = await branches({label: lambda label=label: branch(label) for label in ('alpha', 'beta', 'gamma')})
        request_interaction({'surfaceId': 'main', 'viewRevision': 'branch-lock', 'component': 'test.Review/v1', 'props': {}})
        return dspy.Prediction(answers=answers)

class ObservedExecutor(Executor):
    async def run(self, *args, **kwargs):
        existing = asyncio.all_tasks()
        try:
            return await super().run(*args, **kwargs)
        finally:
            notify_stream_data([], 'updates', {'kind': 'spike-tasks', 'count': len([task for task in asyncio.all_tasks() - existing if not task.done()])})

def create_agent():
    return ObservedExecutor(Program())
`,
  };
}
