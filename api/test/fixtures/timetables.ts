export const SCHOOL_URL = "https://urniki.easistent.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/razredi/748283";
export const SCHOOL_ROOT = "https://urniki.easistent.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33";
export const ROOM_ONE_URL = "https://urniki.easistent.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/ucilnice/1333027";
export const ROOM_TWO_URL = "https://urniki.easistent.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/ucilnice/1333035";
export const CLASS_AJAX_URL = "https://urniki.easistent.com/urniki/ajax_urnik/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/815595/0/0/0/12/0/1";
export const ROOM_ONE_AJAX_URL = "https://urniki.easistent.com/urniki/ajax_urnik/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/0/0/0/9101/12/0/1";
export const ROOM_TWO_AJAX_URL = "https://urniki.easistent.com/urniki/ajax_urnik/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/0/0/0/9102/12/0/1";

export const CLASS_PAGE = `<!doctype html><html><body>
  <div class="urnik_title">Gimnazija Kranj</div>
  <script>const timetableUrl = "${CLASS_AJAX_URL}";</script>
  <a href="${ROOM_ONE_URL}">Učilnice</a>
  <table><tbody><tr>
    <th id="urnik-ura-1"><span class="potek-ure">7:10 - 7:55</span></th>
    <td id="ednevnik-seznam_ur_teden-td-1-2026-11-17"></td>
  </tr></tbody></table>
</body></html>`;

export const ROOM_INDEX_PAGE = `<!doctype html><html><body>
  <div class="urnik_title">Gimnazija Kranj</div>
  <script>const timetableUrl = "${ROOM_ONE_AJAX_URL}";</script>
  <select id="id_parameter">
    <option value="1333027">1</option>
    <option value="1333035">11</option>
  </select>
  <table><tbody><tr>
    <th id="urnik-ura-1"><span class="potek-ure">7:10 - 7:55</span></th>
    <td id="ednevnik-seznam_ur_teden-td-1-2026-11-17"></td>
  </tr></tbody></table>
</body></html>`;

export const ROOM_FREE_PAGE = `<!doctype html><html><body><table><tbody><tr>
  <th id="urnik-ura-1"><span class="potek-ure">7:10 - 7:55</span></th>
  <td id="ednevnik-seznam_ur_teden-td-1-2026-11-17"></td>
</tr></tbody></table></body></html>`;

export const ROOM_CANCELLED_PAGE = `<!doctype html><html><body>
  <script>const timetableUrl = "${ROOM_TWO_AJAX_URL}";</script>
  <table><tbody><tr>
  <th id="urnik-ura-1"><span class="potek-ure">7:10 - 7:55</span></th>
  <td id="ednevnik-seznam_ur_teden-td-1-2026-11-17">
    <div class="ednevnik-seznam_ur_teden-blok-wrap ednevnik-seznam_ur_teden-td-odpadla-ura">
      <span class="wl-tag-xs" title="Odpadla ura">ODP</span>
    </div>
  </td>
</tr></tbody></table></body></html>`;

export function pageForDate(date: string, occupied = false): string {
  const block = occupied ? `<div class="ednevnik-seznam_ur_teden-blok-wrap"><span>MAT</span></div>` : "";
  return `<!doctype html><html><body><table><tbody><tr>
    <th id="urnik-ura-1"><span class="potek-ure">7:10 - 7:55</span></th>
    <td id="ednevnik-seznam_ur_teden-td-1-${date}">${block}</td>
  </tr></tbody></table></body></html>`;
}
