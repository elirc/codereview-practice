package natsx

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"deliverydispatch/pkg/inbox"
)

// Consume ensures the durable consumer for p on s and fetches and handles
// messages one at a time until ctx is done. The message being handled when ctx
// is cancelled is finished and settled; the rest of its batch is left for
// redelivery.
func Consume(ctx context.Context, js jetstream.JetStream, s Stream, p *inbox.Processor, logger *slog.Logger) {
	log := logger.With("consumer", p.Consumer(), "stream", s.Name)
	var cons jetstream.Consumer
	for {
		var err error
		cons, err = EnsureConsumer(ctx, js, s, p.Consumer(), p.Types())
		if err == nil {
			break
		}
		log.Warn("consumer setup failed", "error", err.Error())
		pause(ctx, setupRetry)
		if ctx.Err() != nil {
			return
		}
	}
	log.Info("consumer started")
	for ctx.Err() == nil {
		batch, err := cons.Fetch(FetchBatch, jetstream.FetchMaxWait(fetchMaxWait))
		if err != nil {
			log.Warn("fetch failed", "error", err.Error())
			pause(ctx, fetchErrorPause)
			continue
		}
		for msg := range batch.Messages() {
			if ctx.Err() != nil {
				continue
			}
			settle(context.WithoutCancel(ctx), msg, p, log)
		}
		if err := batch.Error(); err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			log.Debug("fetch ended", "error", err.Error())
		}
	}
	log.Info("consumer stopped")
}

// WaitForStreams ensures streams, retrying until it succeeds or ctx is done.
// It reports whether the streams were ensured.
func WaitForStreams(ctx context.Context, js jetstream.JetStream, logger *slog.Logger, streams ...Stream) bool {
	for {
		err := EnsureStreams(ctx, js, streams...)
		if err == nil {
			return true
		}
		logger.Warn("stream setup failed", "error", err.Error())
		pause(ctx, setupRetry)
		if ctx.Err() != nil {
			return false
		}
	}
}

func settle(ctx context.Context, msg jetstream.Msg, p *inbox.Processor, log *slog.Logger) {
	numDelivered := uint64(1)
	if md, err := msg.Metadata(); err == nil {
		numDelivered = md.NumDelivered
	}
	out := p.Process(ctx, msg.Subject(), msg.Data(), numDelivered)
	var err error
	if out.Ack {
		err = msg.Ack()
	} else {
		err = msg.NakWithDelay(out.Delay)
	}
	if err != nil {
		log.Warn("settling message failed", "subject", msg.Subject(), "ack", out.Ack, "error", err.Error())
	}
}

func pause(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
