// error-translator.js

/**
 * 에러 번역 규칙
 * key: 에러 메시지에서 찾을 '영어 에러 코드' (패턴)
 * value: { title: "한글 에러명", description: "쉬운 설명과 해결책" }
 */
const translationRules = {
    "error C2143": { // 한글 대신 영어 에러 코드로 검색
        title: "문법 오류: 세미콜론(;) 누락 또는 구문 오류",
        description: "코드의 특정 지점에서 문법이 올바르지 않습니다. 가장 흔한 원인은 문장 끝에 세미콜론(;)을 빠뜨린 경우입니다. 오류가 발생한 코드 줄과 그 바로 윗부분을 확인해 보세요."
    },
    "error C2065": {
        title: "선언되지 않은 식별자",
        description: "사용하려는 변수나 함수의 이름('식별자')이 선언된 적이 없습니다. 이름에 오타가 있는지 확인하거나, 사용 전에 미리 선언했는지 확인하세요. 'cout'이나 'cin'의 경우 '#include <iostream>'과 'using namespace std;'가 필요한 경우가 많습니다."
    },
    "error LNK2019": {
        title: "링크 오류: 외부 심볼을 찾을 수 없음",
        description: "함수를 사용하겠다고 선언만 하고, 실제로 어떻게 동작하는지 정의(구현)하지 않았을 때 발생합니다. 함수를 호출하는 부분은 있는데, 그 함수의 실제 코드가 없는 경우입니다. 함수 이름에 오타가 있거나, 필요한 소스 파일을 빌드에 포함하지 않았을 수 있습니다."
    },
    "error C2664": {
        title: "형 변환 오류: 잘못된 함수 인자",
        description: "함수를 호출할 때 잘못된 타입의 값을 인자(argument)로 전달했습니다. 예를 들어, 숫자를 받아야 하는 함수에 문자열을 넣은 경우입니다. 함수가 어떤 타입의 인자를 필요로 하는지 확인하고, 올바른 타입의 값을 전달해주세요."
    },
    "error C2039": {
        title: "멤버 접근 오류",
        description: "클래스나 구조체에 존재하지 않는 멤버 변수나 멤버 함수에 접근하려고 했습니다. 멤버의 이름에 오타가 있는지, 혹은 public 멤버가 맞는지 확인해 보세요. 포인터를 통해 멤버에 접근할 때는 '.' 대신 '->'를 사용해야 합니다."
    },
    "error C2059": {
        title: "문법 오류",
        description: "코드의 문법이 올바르지 않습니다. 괄호 '{', '(', '}' ')'의 짝이 맞지 않거나, 예약된 키워드를 잘못 사용했을 수 있습니다. 에러 메시지에 명시된 부분을 중심으로 코드를 다시 살펴보세요."
    }
};

/**
 * C++ 컴파일 에러 메시지를 번역하고 HTML로 포맷팅합니다.
 * @param {string} rawError - 번역할 원본 에러 로그
 * @returns {string} - 번역된 내용이 포함된 HTML 문자열
 */
function translateError(rawError) {
    for (const pattern in translationRules) {
        // 에러 메시지 원본에 패턴(예: "error C2143")이 포함되어 있는지 확인
        if (rawError.includes(pattern)) {
            const rule = translationRules[pattern];
            // 일치하는 규칙을 찾으면 포맷팅된 HTML을 반환
            return `
                <div class="error-translation">
                    <h3 class="error-title">${rule.title}</h3>
                    <p class="error-description">${rule.description}</p>
                    <details class="original-error-details">
                        <summary>원본 에러 메시지 보기</summary>
                        <pre class="original-error">${rawError.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                    </details>
                </div>
            `;
        }
    }

    // 일치하는 번역 규칙이 없으면 원본 에러 메시지를 그대로 반환
    return `<pre class="original-error">${rawError.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
}

module.exports = translateError;