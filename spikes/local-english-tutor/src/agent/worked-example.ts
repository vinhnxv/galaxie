// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Prompt fixture: every section prompt shows the model this request and its answer before the
// learner's sentence, so the model sees the exact shape and style to generate. The page never shows
// it. The sentence differs from the page's sample sentences, so the model has nothing to copy.

import type { LessonContent } from './lesson.js';

export const WORKED_EXAMPLE: { readonly sentence: string; readonly lesson: LessonContent } = {
  sentence: 'Can you take a look at my pull request before lunch?',
  lesson: {
    overview: {
      tone: 'neutral',
      translation: 'Bạn xem giúp mình pull request trước giờ ăn trưa được không?',
      meaning:
        'Người nói nhờ một đồng nghiệp review code trong pull request của mình. "Take a look at" ' +
        'nghe nhẹ nhàng hơn "review", còn mốc "before lunch" cho người kia biết việc này cần làm ' +
        'sớm.',
    },
    breakdown: {
      words: [
        {
          word: 'Can',
          ipa: 'kæn',
          meaning: 'có thể (dùng để nhờ ai làm gì)',
          role: 'Động từ khuyết thiếu, mở đầu câu hỏi nhờ vả',
        },
        { word: 'you', ipa: 'juː', meaning: 'bạn', role: 'Đại từ nhân xưng, chủ ngữ' },
        {
          word: 'take',
          ipa: 'teɪk',
          meaning: '(trong cụm take a look) xem',
          role: 'Động từ chính',
        },
        { word: 'a', ipa: 'ə', meaning: 'một', role: 'Mạo từ không xác định, đi với look' },
        {
          word: 'look',
          ipa: 'lʊk',
          meaning: 'cái nhìn, việc xem qua',
          role: 'Danh từ, tân ngữ của take',
        },
        { word: 'at', ipa: 'æt', meaning: 'vào (thứ được xem)', role: 'Giới từ, đi sau look' },
        {
          word: 'my',
          ipa: 'maɪ',
          meaning: 'của mình',
          role: 'Tính từ sở hữu, bổ nghĩa cho pull request',
        },
        {
          word: 'pull',
          ipa: 'pʊl',
          meaning: '(trong pull request) kéo về, gộp vào',
          role: 'Danh từ, ghép với request',
        },
        {
          word: 'request',
          ipa: 'rɪˈkwest',
          meaning: 'yêu cầu; pull request là yêu cầu gộp code',
          role: 'Danh từ, tân ngữ của at',
        },
        { word: 'before', ipa: 'bɪˈfɔːr', meaning: 'trước', role: 'Giới từ chỉ thời gian' },
        {
          word: 'lunch',
          ipa: 'lʌntʃ',
          meaning: 'bữa trưa, giờ ăn trưa',
          role: 'Danh từ, mốc thời gian',
        },
      ],
    },
    pronunciation: {
      tips: [
        {
          focus: 'request /rɪˈkwest/',
          tip: 'Trọng âm rơi vào âm tiết thứ hai: re-QUEST. Đọc /kw/ liền nhau và giữ âm /t/ ở cuối.',
        },
        {
          focus: 'lunch /lʌntʃ/',
          tip: 'Từ kết thúc bằng /ntʃ/: giữ âm /n/ rồi bật nhẹ /tʃ/, đừng đọc thành "lăn".',
        },
        {
          focus: 'Can you /kən juː/',
          tip:
            'Khi nói tự nhiên, "can" đọc nhẹ thành /kən/ và nối với "you". Chỉ đọc mạnh /kæn/ khi ' +
            'muốn nhấn mạnh.',
        },
        {
          focus: 'take a look at /teɪk ə lʊk æt/',
          tip:
            'Nối phụ âm cuối với nguyên âm của từ sau: "take a" nghe như /teɪkə/, "look at" nghe ' +
            'như /lʊkæt/.',
        },
      ],
    },
    phrases: {
      phrases: [
        {
          phrase: 'take a look at',
          meaning: 'xem qua, kiểm tra',
          note:
            'Nghe thân thiện hơn "review" hay "check"; hay dùng khi nhờ người khác xem code hoặc ' +
            'tài liệu.',
        },
        {
          phrase: 'pull request',
          meaning: 'yêu cầu gộp code (PR)',
          note:
            'Thuật ngữ của GitHub; GitLab gọi là merge request. Khi nói chuyện thường gọi tắt là ' +
            '"PR".',
        },
        {
          phrase: 'before lunch',
          meaning: 'trước giờ ăn trưa',
          note: 'Mốc thời gian mềm: cho biết bạn cần sớm mà không tạo áp lực như "ASAP".',
        },
      ],
    },
    usage: {
      whenToUse:
        'Dùng khi bạn đã mở pull request và muốn nhờ một đồng nghiệp cụ thể review, kèm thời điểm ' +
        'bạn mong nhận được phản hồi.',
      situations: [
        'Nhắn riêng cho reviewer trên Slack',
        'Nhắc trong buổi daily standup',
        'Nhờ trưởng nhóm duyệt trước khi merge',
      ],
      avoid:
        'Không nên dùng khi việc thật sự khẩn cấp, vì câu này nghe nhẹ nhàng. Khi đó hãy nói rõ lý ' +
        'do gấp, ví dụ lỗi đang ảnh hưởng tới khách hàng.',
    },
    examples: {
      examples: [
        {
          en: 'Could you take a look at the failing test when you have a minute?',
          vi: 'Khi nào rảnh, bạn xem giúp mình cái test đang lỗi được không?',
        },
        {
          en: 'Can you review my changes before the release?',
          vi: 'Bạn review giúp mình các thay đổi trước đợt phát hành được không?',
        },
        {
          en: "I'll take a look at your pull request after the meeting.",
          vi: 'Mình sẽ xem pull request của bạn sau buổi họp.',
        },
      ],
    },
    caseStudy: {
      title: 'Nhờ review trước giờ ăn trưa',
      setting:
        'Minh vừa sửa xong một lỗi đăng nhập và muốn merge trong buổi sáng. Anh nhắn cho Lan, ' +
        'người hiểu rõ module đăng nhập nhất.',
      dialogue: [
        {
          speaker: 'Minh',
          en: 'Hi Lan, can you take a look at my pull request before lunch?',
          vi: 'Chào Lan, bạn xem giúp mình pull request trước giờ ăn trưa được không?',
        },
        {
          speaker: 'Lan',
          en: 'Sure. Is it the login fix?',
          vi: 'Được chứ. Bản sửa lỗi đăng nhập phải không?',
        },
        {
          speaker: 'Minh',
          en: "Yes, it's small. Only one file changed.",
          vi: 'Đúng rồi, nhỏ thôi. Chỉ sửa một file.',
        },
        {
          speaker: 'Lan',
          en: "Great, I'll check it in ten minutes.",
          vi: 'Tốt quá, mười phút nữa mình xem.',
        },
      ],
      takeaway:
        'Nói rõ việc cần nhờ và thời điểm mong muốn giúp người kia sắp xếp thời gian, mà câu nhờ ' +
        'vẫn lịch sự.',
    },
  },
};
