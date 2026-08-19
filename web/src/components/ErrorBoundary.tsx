import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 한 화면이 터져도 앱 전체가 내려앉지 않게 막는 울타리.
 *
 * 미니PC 에서 종목발굴을 열면 **화면이 통째로 까매졌다.** 원인은 한 줄이었다 —
 * 웹은 새로 배포됐는데 서버가 아직 옛 코드로 돌아서 신호등 응답에 `axes` 가 없었고,
 * `data.axes.map(...)` 이 던진 예외가 React 트리를 통째로 걷어냈다.
 * 남는 건 body 배경뿐이라 검은 화면이 된다.
 *
 * 원인은 원인대로 고쳤지만, **그 한 줄이 앱 전체를 죽일 수 있다는 것 자체가 결함이다.**
 * 이 앱은 화면 하나가 수십 개 API 를 부르고, 서버와 웹이 따로 배포된다 —
 * 둘이 어긋나는 창은 배포할 때마다 열린다. 그때 사용자가 보는 것이
 * 검은 화면이면 무엇이 잘못됐는지 알 길이 없다.
 *
 * 그래서 **무엇이 터졌는지 보여 주고 나머지는 살려 둔다.**
 */

interface Props {
  children: ReactNode;
  /** 어디서 터졌는지 — 화면 이름 */
  where?: string;
  /** 이 값이 바뀌면 다시 그려 본다 (탭을 옮기면 회복되게) */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // 다른 화면으로 옮기면 다시 시도한다 — 한 번 터졌다고 영영 막아 두면 안 된다
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 콘솔에는 남겨 둔다. 화면 문구만으로는 원인을 못 좇는다
    console.error(`[화면 오류] ${this.props.where ?? ""}`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <section className="card">
        <h2>이 화면을 그리다 멈췄습니다</h2>
        <p className="page-note">
          {this.props.where && (
            <>
              <b>{this.props.where}</b>에서 오류가 났습니다.{" "}
            </>
          )}
          앱을 다시 켤 필요는 없습니다 — 다른 메뉴는 그대로 씁니다.
        </p>
        <pre className="err-detail">{error.message}</pre>
        <div className="filter-row">
          <button className="filter-btn" onClick={() => this.setState({ error: null })}>
            다시 그리기
          </button>
          <button className="filter-btn" onClick={() => window.location.reload()}>
            새로고침
          </button>
        </div>
        <div className="table-note">
          {/*
            실제로 겪은 원인이라 먼저 적어 둔다. 서버만 옛 코드로 남는 일이 배포마다 생긴다.
          */}
          방금 배포했다면 <b>서버가 아직 옛 코드로 돌고 있을 수 있습니다.</b> 미니PC 에서{" "}
          <b>update-minipc.bat</b> 을 다시 돌리거나 서비스를 재시작해 보세요.
        </div>
      </section>
    );
  }
}
