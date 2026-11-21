import {writeAtomicRecord,recordPersistenceDiagnostic} from './atomic-record-file.mjs';

export function writeTaskRecord(file, record) { return writeAtomicRecord(file, record); }
export function taskPersistenceDiagnostic(error, record) {
    return {
        ...recordPersistenceDiagnostic(error),
        phase: typeof record?.phase === 'string' && /^[a-z-]{1,16}$/.test(record.phase) ? record.phase : 'unknown',
        sequence: Number.isSafeInteger(record?.sequence) && record.sequence > 0 ? record.sequence : null,
    };
}
