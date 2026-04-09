export const toStudentId = (value) => {
  if (!value) {
    return null;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const digits = text.match(/\d+/);
  if (digits?.[0]) {
    return digits[0];
  }

  return text.replace(/^S/i, "").replace(/I$/i, "");
};

export const toYyyyMmDd = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
};

export const withDefaultRange = (begin, end) => {
  if (begin && end) {
    return { begin, end };
  }

  const now = new Date();
  const plus7 = new Date(now);
  plus7.setDate(now.getDate() + 7);

  return {
    begin: begin || toYyyyMmDd(now),
    end: end || toYyyyMmDd(plus7)
  };
};

export const flattenNotesGroups = (groups) => {
  const result = [];

  for (const [group, list] of Object.entries(groups || {})) {
    if (!Array.isArray(list)) {
      continue;
    }

    for (const item of list) {
      result.push({
        group,
        ...item
      });
    }
  }

  return result.sort((a, b) => String(b.evtDate).localeCompare(String(a.evtDate)));
};
