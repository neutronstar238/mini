struct X{X()=default;X(const X&)=delete;}; int main(){X a;X b=a;}
