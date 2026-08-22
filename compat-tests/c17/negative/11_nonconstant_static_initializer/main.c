static int make_value(void) {
    return 3;
}
static int value = make_value();
int main(void) {
    return value;
}
