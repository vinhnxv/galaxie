// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// The page's user-facing text, in Vietnamese. Components read every string from here.

import type { SectionName } from '../agent/lesson.js';

const decimal = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
const megabytes = (bytes: number): string => decimal.format(bytes / 1e6);

export const vi = {
  title: 'Gia sư tiếng Anh chạy trên máy bạn',
  subtitle:
    'Một agent LangGraph.js dùng LFM3-1.7B chạy trên WebGPU. Mọi nội dung bài học do model sinh ' +
    'ra ngay trong trình duyệt; trang chỉ kết nối tới huggingface.co để tải file model.',
  engine: {
    checkingCache: 'Đang kiểm tra model trong bộ nhớ của trình duyệt…',
    consent: (bytes: number): string =>
      `Lần đầu dùng, trình duyệt cần tải model LFM3-1.7B (khoảng ${decimal.format(bytes / 1e9)} ` +
      'GB) từ huggingface.co và lưu lại. Từ lần sau, model được đọc từ bộ nhớ của trình duyệt.',
    download: 'Tải model',
    checkingGpu: 'Đang kiểm tra WebGPU…',
    loadingFile: (file: string, loaded: number, total: number): string =>
      `Đang đọc ${file}: ${megabytes(loaded)} / ${megabytes(total)} MB`,
    creatingSession: 'Đang khởi tạo model trên GPU…',
    ready: (gpu: string, milliseconds: number): string =>
      `Model đã sẵn sàng trên GPU ${gpu} (nạp trong ${decimal.format(milliseconds / 1000)} giây).`,
    failed: (message: string): string => `Không tải được model: ${message}`,
    retry: 'Thử lại',
  },
  input: {
    label: 'Nhập một câu tiếng Anh',
    placeholder: 'Ví dụ: We freeze releases two days before the holiday just to be safe.',
    submit: 'Phân tích',
    samples: 'Hoặc bấm vào một câu:',
    needsModel: 'Model cần sẵn sàng trước khi phân tích.',
  },
  sections: {
    overview: 'Nghĩa của câu',
    breakdown: 'Từng từ: IPA, nghĩa và vai trò',
    pronunciation: 'Mẹo phát âm',
    phrases: 'Cụm từ nên học',
    usage: 'Khi nào dùng câu này',
    examples: 'Ví dụ tương tự',
    caseStudy: 'Tình huống thực tế',
  } satisfies Record<SectionName, string>,
  tone: { formal: 'Trang trọng', neutral: 'Trung tính', informal: 'Thân mật' },
  status: {
    waiting: 'Đang chờ tới lượt…',
    writing: (characters: number): string => `Model đang viết… (${characters} ký tự)`,
    failed: 'Model chưa trả về nội dung đúng cấu trúc.',
    lastReply: 'Câu trả lời cuối của model',
    runFailed: (message: string): string => `Agent dừng vì lỗi: ${message}`,
  },
  words: {
    word: 'Từ',
    ipa: 'IPA',
    meaning: 'Nghĩa',
    role: 'Vai trò',
    pending: '…',
    kept: 'khớp từ điển',
    changed: 'model sửa',
    changedTitle: (forms: readonly string[]): string =>
      `Từ điển ghi: ${forms.map((form) => `/${form}/`).join(', ')}`,
    modelOnly: 'model tự phiên âm',
    caveat:
      'Pipeline tra CMU Pronouncing Dictionary rồi đưa kết quả cho model rà lại theo ngữ cảnh ' +
      'câu. IPA hiển thị là của model; nhãn cho biết nó khớp, khác từ điển, hay là từ không có ' +
      'trong từ điển. Model nhỏ nên có thể sai.',
  },
  usage: {
    when: 'Khi nào dùng',
    situations: 'Tình huống thường gặp',
    avoid: 'Khi nào không nên dùng',
  },
  caseStudy: { setting: 'Bối cảnh', takeaway: 'Điều rút ra' },
  phrasesEmpty: 'Câu này không có cụm từ nào đáng chú ý.',
  actions: {
    speak: 'Nghe',
    speakText: (text: string): string => `Nghe: ${text}`,
    learnThis: 'Học câu này',
    noVoice: 'Máy chưa có giọng đọc tiếng Anh cài sẵn, nên nút nghe bị tắt.',
  },
  stats: {
    title: 'Số liệu lần chạy này',
    section: 'Phần',
    readyAfter: 'Xong sau (giây)',
    tokens: 'Token vào / ra',
    speed: 'Tốc độ (token/giây)',
    attempts: 'Số lần thử',
    unknown: '—',
    seconds: (milliseconds: number): string => decimal.format(milliseconds / 1000),
    number: (value: number): string => decimal.format(value),
  },
};
