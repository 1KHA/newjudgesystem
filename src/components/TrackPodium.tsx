import { Trophy, Medal, AlertTriangle } from 'lucide-react';
import type { LeaderboardEntry } from '../types';

interface Props {
  leaderboard: LeaderboardEntry[];
  /** Track names in display order (session order). Defaults to order of appearance. */
  trackOrder?: string[];
  /** true once the session has ended: titles say "final" */
  final?: boolean;
  /** Team currently being judged (highlighted). */
  currentTeam?: string | null;
}

const PLACE = ['', 'الأول', 'الثاني', 'الثالث'];

/**
 * Top 3 overall and top 3 of every track, from the server-side ranking
 * (session_leaderboard). Tied teams share a place, so a podium can hold more
 * than 3 teams when there is a tie.
 */
export default function TrackPodium({ leaderboard, trackOrder, final = false, currentTeam }: Props) {
  const scored = leaderboard.filter((e) => e.answerCount > 0);
  if (scored.length === 0) {
    return (
      <div className="empty-state">
        <Trophy />
        <h3>لا توجد نتائج بعد</h3>
        <p>يظهر الأوائل هنا بمجرد وصول أول تقييم</p>
      </div>
    );
  }

  const maxJudges = Math.max(...leaderboard.map((e) => e.judgeCount));
  const tracks = (trackOrder && trackOrder.length ? trackOrder : leaderboard.map((e) => e.track ?? ''))
    .filter((t, i, a) => a.indexOf(t) === i);
  const hasTracks = tracks.some(Boolean);

  const podium = (entries: LeaderboardEntry[], rankOf: (e: LeaderboardEntry) => number, showTrack: boolean) => {
    const top = entries.filter((e) => e.answerCount > 0 && rankOf(e) <= 3)
      .sort((a, b) => rankOf(a) - rankOf(b) || b.totalPoints - a.totalPoints);
    const counts = new Map<number, number>();
    top.forEach((e) => counts.set(rankOf(e), (counts.get(rankOf(e)) || 0) + 1));
    return (
      <ol className="podium">
        {top.map((e) => {
          const r = rankOf(e);
          return (
            <li key={e.teamName} className={`podium__item podium__item--${r} ${e.teamName === currentTeam ? 'podium__item--current' : ''}`}>
              <span className={`rank-badge rank-badge--${r}`}>{r}</span>
              <div className="podium__body">
                <div className="podium__name">
                  {e.teamName}
                  {(counts.get(r) || 0) > 1 && <span className="badge badge-warning">تعادل</span>}
                </div>
                <div className="podium__meta">
                  <span className="text-xs text-secondary">المركز {PLACE[r]}</span>
                  {showTrack && e.track && <span className="track-badge track-badge--sm">{e.track}</span>}
                  {e.judgeCount < maxJudges && (
                    <span className="podium__warn" title="الدرجة متوسط من قيّم الفريق فقط، وعدد محكميه أقل من غيره">
                      <AlertTriangle /> {e.judgeCount} من {maxJudges} محكمين
                    </span>
                  )}
                </div>
              </div>
              <span className="podium__score">{e.totalPoints.toFixed(2)}</span>
            </li>
          );
        })}
      </ol>
    );
  };

  const overallRank = (e: LeaderboardEntry) => e.overallRank;
  const trackRank = (e: LeaderboardEntry) => e.trackRank;

  return (
    <div className="track-podium">
      <section className="track-podium__overall">
        <h3 className="panel-title"><Trophy /> {final ? 'الأوائل في جميع المسارات' : 'الأوائل حالياً في جميع المسارات'}</h3>
        {podium(leaderboard, overallRank, hasTracks)}
      </section>

      {hasTracks && (
        <section>
          <h3 className="panel-title"><Medal /> {final ? 'الأوائل في كل مسار' : 'الأوائل حالياً في كل مسار'}</h3>
          <div className="track-grid">
            {tracks.map((track) => {
              const entries = leaderboard.filter((e) => (e.track ?? '') === track);
              const judged = entries.filter((e) => e.answerCount > 0).length;
              return (
                <div key={track || '__none'} className="track-card">
                  <div className="track-card__head">
                    <span className="track-badge">{track || 'بدون مسار'}</span>
                    <span className="text-xs text-secondary">{judged} من {entries.length} فرق مقيّمة</span>
                  </div>
                  {judged ? podium(entries, trackRank, false) : <p className="text-sm text-secondary">لم يُقيَّم أي فريق بعد</p>}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
