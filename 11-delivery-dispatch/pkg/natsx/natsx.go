// Package natsx connects to NATS JetStream, declares streams and durable
// consumers, publishes outbox rows and runs consumer fetch loops.
package natsx

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// Stream is a JetStream stream and the subject prefix it captures.
type Stream struct {
	Name   string
	Prefix string
}

// The three streams, one per publishing service.
var (
	StreamOrders   = Stream{Name: "ORDERS", Prefix: "orders"}
	StreamDispatch = Stream{Name: "DISPATCH", Prefix: "dispatch"}
	StreamCouriers = Stream{Name: "COURIERS", Prefix: "couriers"}
)

// Stream settings.
const (
	StreamMaxAge     = 7 * 24 * time.Hour
	DuplicateWindow  = 2 * time.Minute
	ConsumerAckWait  = 30 * time.Second
	FetchBatch       = 32
	fetchMaxWait     = 2 * time.Second
	fetchErrorPause  = time.Second
	setupRetry       = 2 * time.Second
	connectReconnect = 2 * time.Second
)

// Connect opens a NATS connection that keeps reconnecting and returns it with
// its JetStream context.
func Connect(url, name string, logger *slog.Logger) (*nats.Conn, jetstream.JetStream, error) {
	nc, err := nats.Connect(url,
		nats.Name(name),
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(connectReconnect),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			if err != nil {
				logger.Warn("nats disconnected", "error", err.Error())
			}
		}),
		nats.ReconnectHandler(func(c *nats.Conn) {
			logger.Info("nats reconnected", "url", c.ConnectedUrl())
		}),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("connect to nats: %w", err)
	}
	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		return nil, nil, fmt.Errorf("open jetstream: %w", err)
	}
	return nc, js, nil
}

// EnsureStreams creates or updates each stream with the standard settings.
func EnsureStreams(ctx context.Context, js jetstream.JetStream, streams ...Stream) error {
	for _, s := range streams {
		_, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
			Name:       s.Name,
			Subjects:   []string{s.Prefix + ".>"},
			Storage:    jetstream.FileStorage,
			MaxAge:     StreamMaxAge,
			Duplicates: DuplicateWindow,
		})
		if err != nil {
			return fmt.Errorf("ensure stream %s: %w", s.Name, err)
		}
	}
	return nil
}

// DurableName returns the durable consumer name for a consuming service and stream.
func DurableName(service string, s Stream) string {
	return service + "-on-" + s.Name
}

// EnsureConsumer creates or updates a durable pull consumer on s filtered to
// the given event types.
func EnsureConsumer(ctx context.Context, js jetstream.JetStream, s Stream, durable string, types []string) (jetstream.Consumer, error) {
	subjects := make([]string, 0, len(types))
	for _, t := range types {
		subjects = append(subjects, s.Prefix+"."+t)
	}
	c, err := js.CreateOrUpdateConsumer(ctx, s.Name, jetstream.ConsumerConfig{
		Durable:        durable,
		AckPolicy:      jetstream.AckExplicitPolicy,
		AckWait:        ConsumerAckWait,
		DeliverPolicy:  jetstream.DeliverAllPolicy,
		FilterSubjects: subjects,
	})
	if err != nil {
		return nil, fmt.Errorf("ensure consumer %s: %w", durable, err)
	}
	return c, nil
}

// Publisher publishes outbox rows to JetStream with the event id as message id.
type Publisher struct {
	js jetstream.JetStream
}

// NewPublisher returns a Publisher on js.
func NewPublisher(js jetstream.JetStream) *Publisher {
	return &Publisher{js: js}
}

// Publish sends payload to subject and waits for the stream's acknowledgement.
func (p *Publisher) Publish(ctx context.Context, subject, msgID string, payload []byte) error {
	_, err := p.js.Publish(ctx, subject, payload, jetstream.WithMsgID(msgID))
	return err
}
