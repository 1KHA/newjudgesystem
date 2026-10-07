import { useRef, useState } from 'react';
import {
  FileSpreadsheet, Upload, Download, AlertCircle, AlertTriangle, CheckCircle2, Loader2, X, Save
} from 'lucide-react';
import { parseTeamRows, parseCsv, nameKey, TEAM_IMPORT_LIMITS, type TeamImportResult } from '../lib/teamImport';
import { upsertTeams } from '../lib/supabaseService';
import type { SessionTeam } from '../types';

interface Props {
  /** Names already in the master team list (to label rows as new vs. update). */
  existingNames: string[];
  /** Called after a successful save with the saved teams, in file order. */
  onSaved: (teams: SessionTeam[]) => void | Promise<void>;
}

const ACCEPT = [
  '.xlsx', '.csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv', 'text/comma-separated-values',
].join(',');

const TEMPLATE_URL = '/templates/teams-template.xlsx';
const MAX_SHOWN_ISSUES = 15;

type Phase = 'idle' | 'reading' | 'preview' | 'saving' | 'saved';

/**
 * Upload teams + tracks from an Excel (.xlsx) or CSV file.
 * Everything is parsed and validated in the browser; nothing is written until
 * the admin confirms, and then all teams are saved in ONE request.
 */
export default function TeamUploadPanel({ existingNames, onSaved }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<TeamImportResult | null>(null);
  const [fileError, setFileError] = useState('');
  const [savedCount, setSavedCount] = useState(0);

  const existing = new Set(existingNames.map(nameKey));

  const reset = () => {
    setPhase('idle');
    setResult(null);
    setFileError('');
    setFileName('');
    if (inputRef.current) inputRef.current.value = '';
  };

  const readRows = async (file: File): Promise<unknown[][]> => {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.xls')) throw new Error('صيغة xls القديمة غير مدعومة. افتح الملف في Excel واحفظه بصيغة xlsx');
    if (lower.endsWith('.numbers')) throw new Error('ملفات Numbers غير مدعومة. من Numbers: مشاركة ثم تصدير ثم Excel');
    if (lower.endsWith('.csv') || file.type === 'text/csv') return parseCsv(await file.text());
    // .xlsx: load the reader only now, so judges never download it
    const { readSheet } = await import('read-excel-file/browser');
    try {
      return (await readSheet(file)) as unknown[][];
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'XLS_FILE_NOT_SUPPORTED') throw new Error('صيغة xls القديمة غير مدعومة. احفظ الملف بصيغة xlsx', { cause: e });
      throw new Error('تعذر قراءة الملف. تأكد أنه ملف Excel ‏(.xlsx) أو CSV صالح', { cause: e });
    }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setFileError('');
    setResult(null);
    if (file.size > TEAM_IMPORT_LIMITS.maxFileBytes) {
      setFileError('حجم الملف أكبر من 2 ميجابايت. ملف الفرق يكون عادة أقل من 50 كيلوبايت');
      setPhase('preview');
      return;
    }
    setPhase('reading');
    try {
      const rows = await readRows(file);
      setResult(parseTeamRows(rows));
    } catch (e) {
      setFileError((e as Error).message);
    }
    setPhase('preview');
  };

  const handleSave = async () => {
    if (!result || result.errors.length > 0 || result.teams.length === 0) return;
    setPhase('saving');
    try {
      // A name that matches an existing team (ignoring spacing / Latin case) keeps
      // the existing spelling, so the save updates that team instead of adding a twin
      const canonical = new Map(existingNames.map((n) => [nameKey(n), n]));
      const teams = result.teams.map((t) => ({ name: canonical.get(nameKey(t.name)) ?? t.name, track: t.track }));
      await upsertTeams(teams);
      setSavedCount(teams.length);
      await onSaved(teams);
      setResult(null);
      setPhase('saved');
      if (inputRef.current) inputRef.current.value = '';
    } catch (e) {
      console.error('Error saving teams:', e);
      setFileError('تعذر حفظ الفرق. تحقق من الاتصال وحاول مرة أخرى، لم يُحفظ أي شيء');
      setPhase('preview');
    }
  };

  const errors = result?.errors ?? [];
  const warnings = result?.warnings ?? [];
  const newCount = result ? result.teams.filter((t) => !existing.has(nameKey(t.name))).length : 0;
  const updateCount = result ? result.teams.length - newCount : 0;
  const canSave = Boolean(result) && errors.length === 0 && (result?.teams.length ?? 0) > 0 && !fileError;

  return (
    <div className="panel panel--muted mb-5 upload-panel">
      <div className="upload-panel__head">
        <div>
          <div className="panel-title"><FileSpreadsheet /> رفع الفرق من ملف Excel</div>
          <p className="text-xs text-secondary">عمودان فقط: اسم الفريق والمسار. صيغة xlsx أو csv.</p>
        </div>
        <a className="btn btn-secondary btn-sm" href={TEMPLATE_URL} download="نموذج-الفرق.xlsx">
          <Download />
          تحميل النموذج
        </a>
      </div>

      <input
        ref={inputRef}
        id="teamsFile"
        type="file"
        accept={ACCEPT}
        className="upload-panel__input"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      {(phase === 'idle' || phase === 'saved') && (
        <label htmlFor="teamsFile" className="btn btn-primary btn-block upload-panel__pick">
          <Upload />
          اختيار ملف الفرق
        </label>
      )}

      {phase === 'saved' && (
        <div className="alert alert-success mt-3 mb-0">
          <CheckCircle2 />
          <span>تم حفظ {savedCount} فريق وتحديدها لهذه الجلسة.</span>
        </div>
      )}

      {phase === 'reading' && (
        <div className="upload-panel__status"><Loader2 className="spin" /> جاري قراءة {fileName}...</div>
      )}

      {(phase === 'preview' || phase === 'saving') && (
        <div className="upload-preview">
          <div className="upload-preview__file">
            <FileSpreadsheet />
            <span className="fw-600">{fileName}</span>
            <button className="icon-btn" onClick={reset} title="إلغاء" aria-label="إلغاء"><X /></button>
          </div>

          {fileError && (
            <div className="alert alert-danger" role="alert"><AlertCircle /><span>{fileError}</span></div>
          )}

          {result && (
            <>
              <div className="upload-preview__summary">
                <span className="badge badge-primary">{result.teams.length} فريق</span>
                <span className="badge badge-neutral">{result.tracks.length} مسار</span>
                {newCount > 0 && <span className="badge badge-success">{newCount} جديد</span>}
                {updateCount > 0 && <span className="badge badge-warning">{updateCount} موجود (يُحدَّث مساره)</span>}
              </div>

              {result.tracks.length > 0 && (
                <div className="upload-preview__tracks">
                  {result.tracks.map((t) => (
                    <span key={t.name} className="track-badge">{t.name} <b>{t.count}</b></span>
                  ))}
                </div>
              )}

              {errors.length > 0 && (
                <div className="alert alert-danger" role="alert">
                  <AlertCircle />
                  <div>
                    <div className="fw-700 mb-2">يوجد {errors.length} خطأ في الملف. صححها ثم ارفع الملف مرة أخرى:</div>
                    <ul className="upload-preview__issues">
                      {errors.slice(0, MAX_SHOWN_ISSUES).map((e, i) => (
                        <li key={i}>{e.row ? `السطر ${e.row}: ` : ''}{e.message}</li>
                      ))}
                      {errors.length > MAX_SHOWN_ISSUES && <li>و{errors.length - MAX_SHOWN_ISSUES} أخطاء أخرى</li>}
                    </ul>
                  </div>
                </div>
              )}

              {warnings.map((w, i) => (
                <div key={i} className="alert alert-warning"><AlertTriangle /><span>{w.message}</span></div>
              ))}

              {result.teams.length > 0 && (
                <div className="table-wrap upload-preview__table">
                  <table className="leaderboard-table">
                    <thead>
                      <tr>
                        <th className="num" style={{ width: '56px' }}>السطر</th>
                        <th>اسم الفريق</th>
                        <th>المسار</th>
                        <th style={{ width: '80px' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.teams.map((t) => (
                        <tr key={t.row}>
                          <td className="num text-secondary">{t.row}</td>
                          <td className="fw-600">{t.name}</td>
                          <td><span className="track-badge">{t.track}</span></td>
                          <td>
                            {existing.has(nameKey(t.name))
                              ? <span className="badge badge-warning">تحديث</span>
                              : <span className="badge badge-success">جديد</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          <div className="flex gap-2 mt-3">
            <button className="btn btn-primary flex-1" onClick={handleSave} disabled={!canSave || phase === 'saving'}>
              {phase === 'saving' ? <Loader2 className="spin" /> : <Save />}
              {phase === 'saving' ? 'جاري الحفظ...' : `حفظ ${result?.teams.length ?? 0} فريق`}
            </button>
            <label htmlFor="teamsFile" className="btn btn-secondary">
              <Upload />
              ملف آخر
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
