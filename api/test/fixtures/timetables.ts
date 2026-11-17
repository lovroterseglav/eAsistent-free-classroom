export const SCHOOL_URL = "https://urniki.easistent.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/razredi/748283";
export const SCHOOL_ROOT = "https://urniki.easistent.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33";
export const ROOM_ONE_URL = "https://urniki.easistent.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/ucilnice/1333027";
export const ROOM_TWO_URL = "https://urniki.easistent.com/urniki/56149a5b3eb5cbefdaf9c9ded39a80c8c31d8f33/ucilnice/1333035";

export const CLASS_PAGE = `<!doctype html><html><body>
  <div class="urnik_title">Gimnazija Kranj</div>
  <a href="${ROOM_ONE_URL}">Učilnice</a>
  <table><tbody><tr>
    <th id="urnik-ura-1"><span class="potek-ure">7:10 - 7:55</span></th>
    <td id="ednevnik-seznam_ur_teden-td-1-2026-11-17"></td>
  </tr></tbody></table>
</body></html>`;

export const ROOM_INDEX_PAGE = `<!doctype html><html><body>
  <div class="urnik_title">Gimnazija Kranj</div>
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
  <td id="ednevnik-seznam_ur_teden-td-1-2026-11-17"></td>
</tr></tbody></table></body></html>`;

export const ROOM_CANCELLED_PAGE = `<!doctype html><html><body><table><tbody><tr>
  <td id="ednevnik-seznam_ur_teden-td-1-2026-11-17">
    <div class="ednevnik-seznam_ur_teden-blok-wrap ednevnik-seznam_ur_teden-td-odpadla-ura">
      <span class="wl-tag-xs" title="Odpadla ura">ODP</span>
    </div>
  </td>
</tr></tbody></table></body></html>`;
